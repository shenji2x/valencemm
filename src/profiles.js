const { ApiError } = require('./errors');

const THEMES = ['midnight', 'amethyst', 'ocean', 'forest', 'paper'];
const LAYOUTS = ['centered', 'left', 'glass'];
const FONTS = ['sans', 'mono'];
const SLOTS = ['avatar', 'background', 'video'];
const fail = (message) => { throw new ApiError(400, 'invalid_profile', message); };
function text(value, max, label) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b-\u001f]/.test(value)) fail(`${label} must be text up to ${max} characters`);
  return value.trim();
}
function safeLink(raw) {
  let u;
  try { u = new URL(raw); } catch { fail('Links must be complete https:// addresses'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.href.length > 500) fail('Use an HTTPS link without a username or password');
  return u.href;
}
function defaultProfile(account) {
  return { displayName: account.name, bio: '', theme: 'midnight', layout: 'centered', font: 'sans', effect: 'none', links: [], published: false, showDealButton: true };
}
function validateProfile(input, account) {
  const premium = account.premium?.active === true;
  const p = { displayName: text(input.displayName, 60, 'Display name'), bio: text(input.bio || '', 300, 'Bio') };
  if (!p.displayName) fail('Enter a display name');
  for (const [key, values, fallback] of [['theme', THEMES, 'midnight'], ['layout', LAYOUTS, 'centered'], ['font', FONTS, 'sans'], ['effect', ['none', 'glow', 'rise'], 'none']]) {
    p[key] = input[key] || fallback;
    if (!values.includes(p[key])) fail(`Unknown ${key}`);
  }
  if (!premium && (p.layout === 'glass' || p.effect !== 'none')) throw new ApiError(403, 'premium_required', 'Glass layout and animated effects require Premium');
  if (!Array.isArray(input.links) || input.links.length > (premium ? 30 : 10)) fail(`You can add up to ${premium ? 30 : 10} links`);
  p.links = input.links.map((l) => {
    if (!l || typeof l !== 'object') fail('Invalid link');
    const label = text(l.label, 60, 'Link label');
    if (!label) fail('Each link needs a label');
    return { label, url: safeLink(l.url) };
  });
  if (typeof input.published !== 'boolean' || typeof input.showDealButton !== 'boolean') fail('Invalid publication settings');
  p.published = input.published;
  p.showDealButton = input.showDealButton;
  return p;
}

module.exports = { THEMES, LAYOUTS, FONTS, SLOTS, defaultProfile, validateProfile };
