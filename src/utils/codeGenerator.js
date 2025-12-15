// Generate a random 9-digit code
function generateUserCode() {
  return Math.floor(100000000 + Math.random() * 900000000).toString();
}

module.exports = {
  generateUserCode,
};
