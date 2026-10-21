'use strict';
(() => {
  const E = (tag, attrs = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k,v] of Object.entries(attrs)) {
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  };
  const button = (label, fn, secondary = true) => E('button', { type:'button', class:'btn small' + (secondary ? ' secondary' : ''), onclick:fn }, label);
  const hint = (s) => E('p', {class:'bio-hint'}, s);
  function arrow() {
    const s = document.createElementNS('http://www.w3.org/2000/svg','svg');
    s.setAttribute('viewBox','0 0 24 24'); s.setAttribute('fill','none'); s.setAttribute('stroke','currentColor'); s.setAttribute('stroke-width','1.7'); s.setAttribute('aria-hidden','true');
    const p = document.createElementNS(s.namespaceURI,'path'); p.setAttribute('d','M6 18 18 6M6 6h12v12'); s.append(p); return s;
  }
  function renderProfile(root, p, { publicView = false, mediaUrls = {} } = {}) {
    root.textContent = '';
    const card = E('section', {class:`bio-profile bio-theme-${p.theme} bio-layout-${p.layout} bio-font-${p.font} bio-effect-${p.effect}`});
    const url = (slot) => mediaUrls[slot] || p.media?.[slot]?.url;
    let video;
    if (url('background')) card.append(E('img', {class:'bio-bg',src:url('background'),alt:'',decoding:'async'}));
    if (p.premium && url('video')) { video = E('video',{class:'bio-video',src:url('video'),loop:true,playsinline:true,preload:'none','aria-label':'Profile background video'}); video.muted = true; card.append(video); }
    if (url('background') || video) card.append(E('div',{class:'bio-shade','aria-hidden':'true'}));
    const content = E('div',{class:'bio-content'});
    content.append(url('avatar') ? E('img',{class:'bio-avatar',src:url('avatar'),alt:p.displayName + ' avatar',width:90,height:90}) : E('div',{class:'bio-avatar bio-initial','aria-hidden':'true'},(p.displayName || 'V').slice(0,1).toUpperCase()));
    content.append(E(publicView ? 'h1' : 'h2',{class:'bio-name'},p.displayName || 'Your name'), E('p',{class:'bio-handle'},'@' + p.handle));
    if (p.premium) content.append(E('span',{class:'bio-badge'},'PREMIUM'));
    if (p.bio) content.append(E('p',{class:'bio-bio'},p.bio));
    const links = E('div',{class:'bio-links'});
    (p.links || []).forEach((l,i) => {
      const link = E('a',{class:'bio-link',href:l.url.startsWith('https://') ? l.url : '#',target:'_blank',rel:'noopener noreferrer nofollow ugc'},E('span',{},l.label || 'New link'),arrow());
      link.addEventListener('click',(e) => {
        if (!publicView) { e.preventDefault(); return; }
        fetch(`/v1/profiles/${encodeURIComponent(p.handle)}/click/${i}`,{method:'POST',keepalive:true}).catch(() => {});
      }); links.append(link);
    });
    if (p.showDealButton) {
      const deal = E('a',{class:'bio-link bio-deal',href:'/dashboard#new/' + encodeURIComponent(p.handle)},E('span',{},'Start a deal with me'),arrow());
      if (!publicView) deal.addEventListener('click',e => e.preventDefault());
      links.append(deal);
    }
    if (!links.childElementCount) links.append(E('p',{class:'bio-bio'},publicView ? 'More links coming soon.' : 'Your links will appear here.'));
    content.append(links);
    if (video) {
      const toggle = E('button',{class:'bio-play',type:'button','aria-pressed':'false'},'Play background video');
      toggle.onclick = async () => { if (video.paused) { try { await video.play(); toggle.textContent = 'Pause background video'; toggle.setAttribute('aria-pressed','true'); } catch { toggle.textContent = 'Video unavailable'; } } else { video.pause(); toggle.textContent = 'Play background video'; toggle.setAttribute('aria-pressed','false'); } };
      content.append(toggle);
    }
    content.append(E('a',{class:'bio-brand',href:'/'},E('img',{src:'/logo.svg',alt:'',width:18,height:18}),'Made with Valence'));
    if (publicView) content.append(E('a',{class:'bio-report',href:'/dashboard#support'},'Report this profile'));
    card.append(content); root.append(card);
  }

  async function renderEditor(view, { api, flash, alive }) {
    const data = await api('GET','/biolink');
    if (!alive()) return;
    let p = data.profile, previewUrls = {}, current = 'Profile', dirty = false;
    const page = E('div',{class:'bio-editor'});
    view.append(page);
    let message = '';
    const params = new URLSearchParams(location.search), session = params.get('premium_session');
    if (session) {
      try { await api('POST','/premium/confirm',{sessionId:session}); const fresh = await api('GET','/biolink'); p = fresh.profile; message = 'Payment verified. Welcome to Premium.'; params.delete('premium_session'); history.replaceState(null,'',location.pathname + (params.size ? '?' + params : '') + location.hash); }
      catch (err) { message = 'Your payment is not confirmed yet. ' + err.message + ' Refresh to check again.'; }
    }
    if (Object.keys(p.media).length) try { previewUrls = (await api('POST','/biolink/media/preview',{})).urls; } catch { /* Show available profile media. */ }
    if (!alive()) return;
    const status = E('p',{class:'bio-hint',role:'status','aria-live':'polite'},message);
    const preview = E('div',{class:'bio-preview'});
    const tabs = E('div',{class:'bio-tabs',role:'tablist','aria-label':'Biolink settings'});
    const panel = E('div',{role:'tabpanel',id:'bio-panel'});
    const stateLabel = E('span',{},p.published ? 'Published' : 'Draft');
    const share = location.origin + '/u/' + encodeURIComponent(p.handle);
    const saveDraft = button(p.published ? 'Unpublish' : 'Save draft',() => save(false));
    const publish = button(p.published ? 'Save changes' : 'Publish profile',() => save(true),false);
    const open = E('a',{class:'btn small secondary',href:share,target:'_blank',rel:'noopener'},'View profile');
    page.append(E('div',{class:'bio-toolbar'},E('div',{},E('h2',{},'Your corner of the internet.'),E('p',{},'Your links, your style. Connected to your next deal.')),E('div',{class:'bio-actions'},saveDraft,publish,open)),
      E('div',{class:'bio-split'},E('section',{class:'bio-controls','aria-label':'Edit your biolink'},tabs,panel,status),E('aside',{class:'bio-preview-wrap','aria-label':'Profile preview'},E('div',{class:'bio-preview-label'},E('span',{},'Live preview'),stateLabel),preview,hint('Preview updates as you edit. Save to update your public page.'))));
    function repaint() { renderProfile(preview,p,{mediaUrls:previewUrls}); stateLabel.textContent = dirty ? 'Unsaved changes' : p.published ? 'Published' : 'Draft'; open.hidden = !p.published; }
    function changed() { dirty = true; repaint(); }
    async function save(published) {
      saveDraft.disabled = publish.disabled = true; status.textContent = 'Saving…';
      try { const result = await api('POST','/biolink',{...p,published}); p = result.profile; dirty = false; status.textContent = published ? 'Published. Your profile is ready to share.' : 'Saved privately. Your public profile is unpublished.'; publish.textContent = p.published ? 'Save changes' : 'Publish profile'; saveDraft.textContent = p.published ? 'Unpublish' : 'Save draft'; repaint(); }
      catch(err) { status.textContent = err.message; } finally { saveDraft.disabled = publish.disabled = false; }
    }
    function field(label,key,{area=false,max=60}={}) {
      const input = E(area ? 'textarea':'input',{id:'bio-'+key,maxlength:max,type:area ? null:'text'}); input.value=p[key] || '';
      input.addEventListener('input',() => {p[key]=input.value;changed();}); panel.append(E('label',{for:input.id},label),input);
    }
    function select(label,key,items) {
      const input = E('select',{id:'bio-'+key},items.map(([v,l]) => E('option',{value:v},l))); input.value=p[key];
      input.onchange = () => {p[key]=input.value;changed();}; panel.append(E('label',{for:input.id},label),input);
    }
    async function copy() { try { await navigator.clipboard.writeText(share);status.textContent='Profile link copied.'; } catch {status.textContent='Copy your link: '+share;} }
    function draw() {
      tabs.textContent='';panel.textContent='';
      for (const name of ['Profile','Links','Appearance','Media','Premium']) {
        const tab = E('button',{type:'button',role:'tab',id:'bio-tab-'+name,'aria-selected':String(current===name),'aria-controls':'bio-panel',tabindex:current===name ? '0':'-1',onclick:()=>{current=name;draw();}},name);
        tab.addEventListener('keydown',e => {const names=['Profile','Links','Appearance','Media','Premium']; let i=names.indexOf(current);if(e.key==='ArrowRight')i=(i+1)%5;else if(e.key==='ArrowLeft')i=(i+4)%5;else if(e.key==='Home')i=0;else if(e.key==='End')i=4;else return;e.preventDefault();current=names[i];draw();document.getElementById('bio-tab-'+current).focus();});tabs.append(tab);
      }
      panel.setAttribute('aria-labelledby','bio-tab-'+current);
      if (current==='Profile') {
        field('Display name','displayName'); field('Bio','bio',{area:true,max:300});
        const deal=E('input',{type:'checkbox',id:'bio-deal'});deal.checked=p.showDealButton;deal.onchange=()=>{p.showDealButton=deal.checked;changed();};panel.append(E('label',{for:'bio-deal'},deal,'Show “Start a deal with me”'));
        panel.append(E('label',{for:'bio-share'},'Your profile link'));
        const shareInput=E('input',{id:'bio-share',readonly:true,value:share});panel.append(shareInput,E('div',{class:'bio-actions'},button('Copy link',copy)),hint('Your username is your profile address. Publish before sharing.'));
        panel.append(E('div',{class:'bio-metrics'},E('div',{},E('strong',{},p.analytics?.views || 0),E('small',{},'Profile views')),E('div',{},E('strong',{},p.analytics?.clicks || 0),E('small',{},'Link clicks'))),hint('Aggregate counters. Views are deduplicated per network address each hour; these are not unique-person counts.'));
        if (window.qrcode) { const box=E('div',{class:'bio-qr'}), qr=window.qrcode(0,'M');qr.addData(share);qr.make();const doc=new DOMParser().parseFromString(qr.createSvgTag({cellSize:3,margin:4}),'image/svg+xml');const svg=doc.documentElement;svg.setAttribute('role','img');svg.setAttribute('aria-label','Profile QR code');box.append(document.importNode(svg,true));panel.append(box); }
      }
      if (current==='Links') {
        panel.append(E('h3',{},'Make every link count.'),hint(`Add ${p.premium ? 'up to 30':'up to 10'} links. Put your most important ones first.`));
        p.links.forEach((l,i)=>{const row=E('div',{class:'bio-link-row'});const label=E('input',{id:'bio-label-'+i,maxlength:60,value:l.label}),url=E('input',{id:'bio-url-'+i,type:'url',maxlength:500,value:l.url,placeholder:'https://'});label.oninput=()=>{l.label=label.value;changed();};url.oninput=()=>{l.url=url.value;changed();};
          const up=button('Move up',()=>{[p.links[i-1],p.links[i]]=[p.links[i],p.links[i-1]];changed();draw();});up.disabled=i===0;
          const down=button('Move down',()=>{[p.links[i+1],p.links[i]]=[p.links[i],p.links[i+1]];changed();draw();});down.disabled=i===p.links.length-1;
          row.append(E('label',{for:label.id},'Link '+(i+1)+' · Title'),label,E('label',{for:url.id},'URL'),url,E('div',{class:'bio-link-tools'},up,down,button('Remove',()=>{p.links.splice(i,1);changed();draw();})));panel.append(row);});
        const add=button('Add link',()=>{p.links.push({label:'',url:''});changed();draw();});add.disabled=p.links.length>=(p.premium?30:10);panel.append(add);
      }
      if (current==='Appearance') {
        panel.append(E('h3',{},'Set the mood.'),E('label',{},'Theme'));
        const swatches=E('div',{class:'bio-themes'});for(const t of ['midnight','amethyst','ocean','forest','paper']) swatches.append(E('button',{type:'button',class:'bio-theme-'+t,'aria-pressed':String(p.theme===t),onclick:()=>{p.theme=t;changed();draw();}},t[0].toUpperCase()+t.slice(1)));panel.append(swatches);
        select('Layout','layout',[['centered','Centered'],['left','Left aligned'],...(p.premium?[['glass','Glass · Premium']]:[])]);
        select('Font','font',[['sans','IBM Plex Sans'],['mono','JetBrains Mono']]);
        if(p.premium)select('Effect','effect',[['none','None'],['glow','Avatar glow'],['rise','Link entrance']]);else panel.append(hint('Premium adds glass layout, avatar glow and link entrance effects.'));
      }
      if (current==='Media') {
        panel.append(E('h3',{},'Bring it to life.'),hint('One avatar and one background image, up to 5 MB each. Premium adds one MP4 video up to five minutes AND 100 MB. Up to 10 upload attempts per day.'));
        if(!data.mediaEnabled)panel.append(E('p',{class:'flash warn'},'Uploads are not available yet. R2 storage needs connecting. You can still publish your links and choose a theme.'));
        for(const slot of ['avatar','background','video']) {
          const locked=slot==='video'&&!p.premium;const box=E('div',{class:'bio-upload'},E('h3',{},slot==='avatar'?'Profile image':slot==='background'?'Background image':'Background video · Premium'));
          if(p.media[slot])box.append(hint((p.media[slot].size/1000000).toFixed(1)+' MB uploaded'));
          const input=E('input',{type:'file','aria-label':'Choose '+slot,accept:slot==='video'?'video/mp4':'image/png,image/jpeg,image/webp',disabled:locked||!data.mediaEnabled});
          const upload=button('Upload',async()=>{const f=input.files[0];if(!f)return;upload.disabled=true;status.textContent='Preparing upload…';try{
            if(f.size>(slot==='video'?100000000:5000000))throw new Error('File is too large. Choose a smaller file.');
            const u=await api('POST','/biolink/media/upload',{slot,size:f.size,type:f.type});
            status.textContent='Uploading… Keep this page open.';
            const r=await fetch(u.url,{method:'PUT',headers:u.headers,body:f});if(!r.ok)throw new Error('Upload failed. Please try again.');
            status.textContent='Checking the file on the server…';
            const result=await api('POST','/biolink/media/confirm',{uploadId:u.uploadId});p.media=result.profile.media;previewUrls=(await api('POST','/biolink/media/preview',{})).urls;status.textContent='Media saved. '+(p.published?'Your published profile is updated.':'Publish your profile to share it.');repaint();draw();
          }catch(err){status.textContent=err.message;}finally{upload.disabled=false;}});upload.disabled=locked||!data.mediaEnabled;
          box.append(input,upload);if(locked)box.append(hint('Unlock with a one-time US$20 Premium purchase.'));
          if(p.media[slot])box.append(button('Remove',async()=>{try{const result=await api('POST','/biolink/media/remove',{slot});p.media=result.profile.media;delete previewUrls[slot];repaint();draw();status.textContent='Media removed.';}catch(err){status.textContent=err.message;}}));panel.append(box);
        }
      }
      if (current==='Premium') {
        const plan=E('section',{class:'bio-plan'},E('h3',{},p.premium?'You have Premium.':'More room for you.'),E('p',{class:'bio-price'},'US$20 ',E('small',{},'one-time purchase')),E('ul',{},E('li',{},'One background video · 5 minutes / 100 MB'),E('li',{},'30 links instead of 10'),E('li',{},'Glass layout and visual effects'),E('li',{},'No recurring subscription')));
        if(!p.premium){const buy=button(data.checkoutEnabled?'Get Premium — US$20':'Premium checkout unavailable',async(e)=>{const b=e.currentTarget;b.disabled=true;status.textContent='Opening secure checkout…';try{const result=await api('POST','/premium/checkout',{});if(result.url)location.assign(result.url);else{p.premium=result.premium;draw();}}catch(err){status.textContent=err.message;b.disabled=false;}},false);buy.disabled=!data.checkoutEnabled;plan.append(buy);}
        plan.append(hint('Premium is an account upgrade, separate from deal fees. Access is granted only after Stripe confirms payment. Refunded or disputed purchases lose Premium access.'));
        if(!data.mediaEnabled)plan.append(hint('Video uploads are awaiting the R2 storage connection. Themes, extra links and effects work independently.'));
        panel.append(plan);
      }
    }
    draw();repaint();
  }
  window.ValenceBiolink={renderProfile,renderEditor};
})();
