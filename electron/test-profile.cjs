// Explicit opt-in isolation for source and unpacked desktop review builds.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
function canonical(value) {
  let parent = path.resolve(value), tail = [];
  while (!fs.existsSync(parent) && path.dirname(parent) !== parent) {
    tail.unshift(path.basename(parent)); parent = path.dirname(parent);
  }
  return path.join(fs.realpathSync(parent), ...tail);
}
function testProfile(env, appData, home = os.homedir()) {
  const raw = env.PAPERREAD_TEST_PROFILE;
  if (!raw) return null;
  if (!path.isAbsolute(raw)) throw new Error("PAPERREAD_TEST_PROFILE must be an absolute path");
  const root = canonical(raw);
  const overlaps = (a, b) => {
    a = canonical(a).toLowerCase(); b = canonical(b).toLowerCase();
    return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
  };
  if ([appData, home].some(base => ["PaperRead", "EasyRead"].some(name => overlaps(root, path.join(base, name)))) || root === path.parse(root).root) {
    throw new Error("Test profile must be separate from installed PaperRead/EasyRead data");
  }
  return { userData: path.join(root, "desktop"), env: { EASYREAD_HOME: path.join(root, "home"),
    EASYREAD_LIBRARY: path.join(root, "library"), PAPERREAD_OFFLINE_TEST: "1" } };
}
module.exports = { testProfile };
