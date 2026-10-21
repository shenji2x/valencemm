'use strict';
(async () => {
  const root = document.getElementById('profile');
  const handle = decodeURIComponent(location.pathname.split('/')[2] || '');
  const path = '/v1/profiles/' + encodeURIComponent(handle);
  try {
    const r = await fetch(path);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'Profile unavailable');
    document.title = data.profile.displayName + ' | Valence';
    document.querySelector('meta[name=description]').content = data.profile.bio || 'Explore this Valence profile';
    window.ValenceBiolink.renderProfile(root, data.profile, { publicView: true });
    fetch(path + '/view', { method: 'POST' }).catch(() => {});
  } catch (err) {
    root.textContent = '';
    const p = document.createElement('p'); p.className = 'bio-public-status'; p.textContent = err.message; root.append(p);
  }
})();
