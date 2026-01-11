const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    // Server-side, use the service role key
  });
} else {
  // Supabase not configured - export stubs to avoid startup failures
}

// Upload a PDF buffer to the `pdfs` bucket and return public URL
async function uploadPdf(filePath, destFileName) {
  if (!filePath || !destFileName) {
    throw new Error('filePath and destFileName are required');
  }

  // Validate extension
  if (path.extname(destFileName).toLowerCase() !== '.pdf') {
    throw new Error('Only PDF files are allowed');
  }

  const buffer = fs.readFileSync(filePath);

  const bucket = 'pdfs';
  const ext = path.extname(destFileName).toLowerCase() || '.pdf';
  // Use a safe ASCII-only filename for storage key to avoid invalid key errors
  const uniquePath = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

  // Helper to perform upload
  if (!supabase) throw new Error('Supabase not configured');
  const doUpload = async () => {
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(uniquePath, buffer, { contentType: 'application/pdf', upsert: false });

    if (uploadError) {
      throw uploadError;
    }

    const { data } = supabase.storage.from(bucket).getPublicUrl(uniquePath);
    return data?.publicUrl || null;
  };

  try {
    return await doUpload();
  } catch (err) {
    // If bucket not found, try to create it (requires service role key)
    const isBucketNotFound = err && (err.message?.toLowerCase().includes('bucket not found') || err.status === 400 || err.status === 404 || err.statusCode === '404');
    if (isBucketNotFound) {
      if (!supabase) throw err;
      try {
        // Attempt to create bucket as public
        const { error: createErr } = await supabase.storage.createBucket(bucket, { public: true });
        if (createErr) {
          // Try upload once more
        }
        // Retry upload after attempting to create bucket
        return await doUpload();
      } catch (createError) {
        // Surface clearer error
        const message = createError.message || JSON.stringify(createError);
        const e = new Error(`Supabase bucket '${bucket}' missing and create attempt failed: ${message}`);
        e.original = createError;
        throw e;
      }
    }

    throw err;
  }
}

module.exports = {
  supabase,
  uploadPdf,
};

// Delete a PDF from the `pdfs` bucket given its public URL
async function deletePdfByUrl(publicUrl) {
  if (!publicUrl) return { ok: false, error: 'No URL provided' };
  try {
    const url = new URL(publicUrl);
    const pathname = url.pathname || '';
    // Expecting path like /storage/v1/object/public/pdfs/<key>
    const bucketMarker = '/pdfs/';
    const idx = pathname.indexOf(bucketMarker);
    if (idx === -1) {
      return { ok: false, error: 'Could not determine object path from URL' };
    }
    const objectPath = decodeURIComponent(pathname.substring(idx + bucketMarker.length));
    if (!objectPath) return { ok: false, error: 'Empty object path' };

    if (!supabase) return { ok: false, error: 'supabase not configured' };
    const { error } = await supabase.storage.from('pdfs').remove([objectPath]);
    if (error) {
      return { ok: false, error };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err };
  }
}

module.exports.deletePdfByUrl = deletePdfByUrl;
