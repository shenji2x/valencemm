// Username and password rules for new accounts.

// Names nobody can register: staff, the brand, the payment provider, and words that would let an
// account pass itself off as official. Checked on sign-up only; existing accounts are untouched.
const RESERVED = new Set([
  "admin", "administrator", "root", "superuser", "sysadmin", "system", "owner", "founder", "ceo",
  "support", "help", "helpdesk", "helpline", "staff", "team", "mod", "mods", "moderator", "official",
  "security", "abuse", "legal", "privacy", "terms", "billing", "payment", "payments", "payout",
  "payouts", "refund", "refunds", "escrow", "middleman", "trust", "safety", "verify", "verified",
  "valence", "valencemm", "stripe", "discord", "anthropic", "claude", "api", "webhook", "bot",
  "account", "accounts", "login", "signup", "register", "dashboard", "settings", "docs", "status",
  "contact", "info", "noreply", "no_reply", "postmaster", "webmaster", "hostmaster", "null",
  "undefined", "everyone", "here", "anonymous", "deleted",
]);

// Words that make a name look official wherever they appear ("valence_support", "the_admin").
const RESERVED_PARTS = ["valence", "admin", "support", "official", "moderator", "staff", "verified", "escrow"];

// Undo the usual look-alike substitutions so "v4lence_supp0rt" is read as "valencesupport".
// "1" is read both as "i" and as "l".
function readings(name) {
  const base = name.toLowerCase().replace(/_/g, "")
    .replace(/0/g, "o").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s")
    .replace(/7/g, "t").replace(/8/g, "b").replace(/9/g, "g");
  return [base.replace(/1/g, "i"), base.replace(/1/g, "l")];
}

function reservedUsername(username) {
  const u = String(username || "").toLowerCase();
  if (RESERVED.has(u)) return true;
  return readings(u).some((r) => RESERVED.has(r) || RESERVED_PARTS.some((p) => r.includes(p)));
}

// Passwords that appear at the top of every leaked-password list. Only 8+ characters are listed,
// since shorter ones are already refused.
const COMMON = new Set([
  "password", "password1", "password12", "password123", "password1234", "password!", "passw0rd",
  "p@ssw0rd", "p@ssword", "12345678", "123456789", "1234567890", "0987654321", "87654321",
  "11111111", "00000000", "12341234", "11223344", "1q2w3e4r", "1q2w3e4r5t", "q1w2e3r4", "1qaz2wsx",
  "zaq12wsx", "qazwsx12", "qwerty12", "qwerty123", "qwerty1234", "qwertyui", "qwertyuiop",
  "asdfghjk", "asdfasdf", "zxcvbnm1", "abcd1234", "abc12345", "abcdefgh", "iloveyou", "iloveyou1",
  "sunshine", "princess", "football", "baseball", "superman", "starwars", "trustno1", "whatever",
  "letmein1", "welcome1", "welcome123", "monkey123", "dragon123", "master123", "shadow123",
  "michael1", "jennifer", "computer", "internet", "freedom1", "charlie1", "mustang1", "changeme",
  "default1", "admin123", "admin1234", "root1234", "test1234", "testtest", "guest123", "hello123",
  "hellohello", "valence1", "valence123", "valencemm", "escrow123", "middleman", "bitcoin1",
  "crypto123", "money123", "qwerty!@#", "1234qwer", "q2w3e4r5", "asdf1234", "aa123456",
]);

function isSequence(pw) {
  if (pw.length < 2) return false;
  const step = pw.charCodeAt(1) - pw.charCodeAt(0);
  if (step !== 1 && step !== -1 && step !== 0) return false;
  for (let i = 2; i < pw.length; i++) if (pw.charCodeAt(i) - pw.charCodeAt(i - 1) !== step) return false;
  return true; // "abcdefgh", "98765432", "aaaaaaaa"
}

// Returns a reason string if the password is too easy to guess, otherwise null.
function weakPassword(password, username) {
  const pw = String(password || "").toLowerCase();
  const u = String(username || "").toLowerCase();
  if (COMMON.has(pw)) return "That password is on lists of the most common passwords. Try a longer phrase.";
  if (isSequence(pw)) return "That password is a simple sequence. Try a longer phrase.";
  if (u && (pw === u || (u.length >= 3 && pw.startsWith(u) && pw.length - u.length <= 4))) {
    return "Your password can't be your username. Try a longer phrase.";
  }
  return null;
}

module.exports = { reservedUsername, weakPassword };
