const Material = require('../models/Material');
const Instructor = require('../models/Instructor');
const Chapter = require('../models/Chapter');
const Lecture = require('../models/Lecture');
const PDF = require('../models/PDF');

// Get full content tree
exports.getContentTree = async (req, res) => {
  try {
    const materials = await Material.find().sort({ order: 1 });

    const tree = await Promise.all(
      materials.map(async (material) => {
        const instructors = await Instructor.find({
          materialId: material._id,
        }).sort({ order: 1 });

        const instructorData = await Promise.all(
          instructors.map(async (instructor) => {
            const chapters = await Chapter.find({
              instructorId: instructor._id,
            }).sort({ order: 1 });

            const chapterData = await Promise.all(
              chapters.map(async (chapter) => {
                const lectures = await Lecture.find({
                  chapterId: chapter._id,
                }).sort({ order: 1 });

                const lectureData = await Promise.all(
                  lectures.map(async (lecture) => {
                    const pdfs = await PDF.find({
                      lectureId: lecture._id,
                    }).sort({ order: 1 });

                    return {
                      _id: lecture._id,
                      title: lecture.title,
                      thumbnailUrl: lecture.thumbnailUrl,
                      order: lecture.order,
                      pdfs: pdfs.map((p) => ({
                        _id: p._id,
                        title: p.title,
                      })),
                    };
                  })
                );

                return {
                  _id: chapter._id,
                  title: chapter.title,
                  thumbnailUrl: chapter.thumbnailUrl,
                  order: chapter.order,
                  lectures: lectureData,
                };
              })
            );

            return {
              _id: instructor._id,
              title: instructor.title,
              thumbnailUrl: instructor.thumbnailUrl,
              order: instructor.order,
              chapters: chapterData,
            };
          })
        );

        return {
          _id: material._id,
          title: material.title,
          thumbnailUrl: material.thumbnailUrl,
          order: material.order,
          instructors: instructorData,
        };
      })
    );

    return res.json(tree);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
