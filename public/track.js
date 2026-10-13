(function () {
    const KEY = 'nsai_source';
    const PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'msclkid'];

    function read() {
        try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
    }

    function write(value) {
        try { localStorage.setItem(KEY, JSON.stringify(value)); } catch {}
    }

    const params = new URLSearchParams(location.search);
    const fromUrl = {};
    for (const p of PARAMS) {
        const v = params.get(p);
        if (v) fromUrl[p] = v;
    }

    let source = read();
    if (Object.keys(fromUrl).length || !source) {
        const referrer = document.referrer && !document.referrer.startsWith(location.origin) ? document.referrer : '';
        source = { ...fromUrl, referrer, landing: location.pathname + location.search, firstSeen: new Date().toISOString() };
        write(source);
    }

    window.nsai = {
        source: () => source,
        track(name, data = {}) {
            try {
                (window.dataLayer = window.dataLayer || []).push({ event: name, ...data });
                if (typeof window.gtag === 'function') window.gtag('event', name, data);
                if (typeof window.fbq === 'function') window.fbq('trackCustom', name, data);
            } catch {}
        },
    };
})();
