// Development only: retain the callable v3 API while using minimatch 11's engine.
const modern = require("minimatch");
module.exports = (path, pattern, options) => modern.minimatch(path, pattern, options);
Object.assign(module.exports, modern);
// Explicit properties also expose named exports to native ESM consumers.
module.exports.minimatch = modern.minimatch;
module.exports.Minimatch = modern.Minimatch;
module.exports.GLOBSTAR = modern.GLOBSTAR;
module.exports.sep = modern.sep;
module.exports.filter = modern.filter;
module.exports.defaults = modern.defaults;
module.exports.braceExpand = modern.braceExpand;
module.exports.match = modern.match;
module.exports.escape = modern.escape;
module.exports.unescape = modern.unescape;

// makeRe/AST were removed in v11. No pinned lint consumer uses them.
