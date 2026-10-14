import { isValidPageKey } from "./keys";

/** The opening tag of every beacon; also the marker that makes injection idempotent. */
export const BEACON_OPEN_TAG = "<script data-pages-beacon>";

/**
 * Builds the measurement beacon for one published page: a single inline
 * `<script>` element, ES5 syntax, no external source. It runs only after the
 * gate has decrypted the page. It sends `view` at load, `beat` every 15 s of
 * visible time when the active seconds changed since the last event, and
 * `end` when the page is hidden, each as a text/plain POST
 * with `fetch` and credentials omitted, to `endpoint` only. It reads no page
 * content, sets no cookie, uses no localStorage and keeps one sessionStorage
 * key per site (a random tab session id). Every failure is swallowed.
 *
 * @param args.endpoint the absolute http(s) URL of the ingest route.
 * @param args.ingestKey the site's ingest key.
 * @param args.pageKey the page's key within the site.
 * @returns the `<script>` element as a string.
 * @throws {Error} when an argument is not valid.
 */
export function buildBeaconScript(args: {
  endpoint: string;
  ingestKey: string;
  pageKey: string;
}): string {
  const { endpoint, ingestKey, pageKey } = args;
  let protocol = "";
  try {
    protocol = new URL(endpoint).protocol;
  } catch {
    // Relative or unparsable; refused below.
  }
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error("Beacon endpoint must be an absolute http(s) URL");
  }
  if (!INGEST_KEY_PATTERN.test(ingestKey)) {
    throw new Error("Invalid beacon ingest key");
  }
  if (!isValidPageKey(pageKey)) {
    throw new Error("Invalid beacon page key");
  }
  return `${BEACON_OPEN_TAG}${BEACON_SOURCE}(${embed(endpoint)},${embed(ingestKey)},${embed(pageKey)})</script>`;
}

/**
 * Inserts a beacon immediately before the last `</body>` (any case), or
 * appends it when there is none. Every other byte is unchanged, and a page
 * that already holds a beacon is returned as is.
 *
 * @param html the page's plaintext HTML.
 * @param script the element from buildBeaconScript.
 * @returns the page with exactly one beacon.
 */
export function injectBeacon(html: string, script: string): string {
  if (html.includes(BEACON_OPEN_TAG)) {
    return html;
  }
  let at = -1;
  for (const match of html.matchAll(/<\/body\s*>/gi)) {
    at = match.index;
  }
  return at < 0 ? html + script : html.slice(0, at) + script + html.slice(at);
}

/**
 * Returns a `decoratePage` function for publishSite that adds the beacon,
 * carrying each page's own key, to every page.
 *
 * @param args.endpoint the absolute http(s) URL of the ingest route.
 * @param args.ingestKey the site's ingest key.
 * @returns the page decorator.
 */
export function makeBeaconDecorator(args: {
  endpoint: string;
  ingestKey: string;
}): (html: string, context: { pageKey: string }) => string {
  return (html, { pageKey }) =>
    injectBeacon(html, buildBeaconScript({ ...args, pageKey }));
}

/** The ingest route's ingest key pattern (PagesIngestEventSchema `k`). */
const INGEST_KEY_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

/**
 * A JS string literal that cannot end the script element or open a comment:
 * every "<" is escaped, and so are the two separators older parsers treat as
 * line ends.
 */
function embed(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/*
 * The beacon, called with (endpoint, ingestKey, pageKey). Readable form:
 *
 *   s  tab session id: 20 of [a-z0-9] from crypto (Math.random fallback),
 *      kept under one sessionStorage key per site (the key name carries the
 *      first 8 characters of the ingest key, so sites on one pages origin
 *      never share an id), or in memory if storage throws
 *   st load time in epoch seconds, fixed for the life of the page
 *   a  active seconds: a 1 s tick adds one while the page is visible and the
 *      last interaction was at most 30 s before; ticks only, so throttled or
 *      frozen timers under-count and never over-count; capped at 28800
 *   m  the a of the last event sent
 *   v  visible ticks; every 15 a beat, but only when a differs from m, so an
 *      idle tab sends nothing and cannot saturate the site ceiling
 *   x  1 once an end was sent for the current hidden period
 *
 * A back-forward cache restore (pageshow persisted) re-arms the end and
 * restarts the idle window; it continues the same view (same st), which the
 * ingest upsert merges into one row.
 *
 * The source holds no "<" at all (comparisons are written as ">"), so no
 * sequence in it can close the element or open a comment.
 */
const BEACON_SOURCE =
  "(function(E,K,P){" +
  "var w=window,d=document,n=Date.now,A='abcdefghijklmnopqrstuvwxyz0123456789',N='pages-beacon-sid:'+K.slice(0,8),st=Math.floor(n()/1000),a=0,m=0,v=0,l=n(),x=0,s,g,i,T;" +
  "function id(){var o='',b,j,c;try{b=w.crypto.getRandomValues(new Uint8Array(64))}catch(e){}" +
  "for(j=0;20>o.length;j++){c=b&&b.length>j?b[j]:Math.floor(Math.random()*252);if(252>c)o+=A.charAt(c%36)}return o}" +
  "function send(t,r){try{var b={k:K,p:P,s:s,st:st,t:t,a:a};m=a;if(r)b.r=r;" +
  "w.fetch(E,{method:'POST',mode:'no-cors',credentials:'omit',keepalive:true,headers:{'Content-Type':'text/plain'},body:JSON.stringify(b)})['catch'](function(){})}catch(e){}}" +
  "function ref(){try{var u=new URL(d.referrer),h=u.hostname.toLowerCase();" +
  "if(/^https?:$/.test(u.protocol)&&h!=w.location.hostname.toLowerCase()&&254>h.length&&/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{1,63}$/.test(h)&&!/\\.(local|localhost|test|internal|invalid|example)$/.test(h))return h}catch(e){}}" +
  "function end(){if(!x){x=1;send('end')}}" +
  "function on(o,t,f){o.addEventListener(t,f,{passive:true,capture:true})}" +
  "function act(){l=n()}" +
  "try{" +
  "try{g=w.sessionStorage;s=g.getItem(N)}catch(e){}" +
  "if(!/^[a-z0-9]{20}$/.test(s||'')){s=id();try{g.setItem(N,s)}catch(e){}}" +
  "T=['scroll','click','keydown','touchstart','mousemove'];for(i=0;T.length>i;i++)on(w,T[i],act);" +
  "on(d,'visibilitychange',function(){if(d.visibilityState=='hidden')end();else x=0});" +
  "on(w,'pagehide',end);" +
  "on(w,'pageshow',function(e){if(e.persisted){x=0;l=n()}});" +
  "setInterval(function(){if(d.visibilityState=='visible'){if(30000>=n()-l&&28800>a)a++;if(++v%15==0&&a!=m)send('beat')}},1000);" +
  "send('view',ref())" +
  "}catch(e){}})";
