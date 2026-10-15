/**
 * The gate page served for every protected page. Ported from the reference
 * gate.template.html with only the product title (__TITLE__) and the
 * localStorage key (__STORAGE_KEY__) turned into placeholders; the client
 * crypto and layout are unchanged. String.raw keeps the script's backslashes.
 */
export const GATE_TEMPLATE: string = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>__TITLE__</title>
<style>
:root{--bg:#f2f4f7;--surface:#fff;--fg:#14202f;--muted:#56657a;--line:#cfd7e2;--accent:#2848c9;--bad:#bf2b2b}
@media (prefers-color-scheme:dark){:root{--bg:#0e141d;--surface:#151d29;--fg:#e3e9f2;--muted:#93a2b8;--line:#2a384b;--accent:#7f98ff;--bad:#ff7b7b;color-scheme:dark}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 "IBM Plex Sans","Segoe UI",system-ui,sans-serif;padding:16px}
form{width:min(380px,100%);background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:24px}
h1{margin:0 0 6px;font:700 22px/1.2 "Bricolage Grotesque","Avenir Next","Segoe UI",system-ui,sans-serif}
p{margin:0 0 16px;color:var(--muted);font-size:14px}
label{display:block;font-size:13px;margin-bottom:6px}
input{width:100%;box-sizing:border-box;font:16px ui-monospace,Menlo,monospace;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
button{margin-top:14px;width:100%;font:600 15px inherit;padding:10px;border:0;border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
#msg{min-height:20px;margin-top:10px;font-size:13px;color:var(--bad)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
</head>
<body>
<form id="f" autocomplete="off">
  <h1>__TITLE__</h1>
  <p>This page is access-controlled. Enter the access code you were given. You only need to do this once on this browser.</p>
  <label for="c">Access code</label>
  <input id="c" name="c" type="password" autocapitalize="off" autocomplete="off" spellcheck="false" autofocus>
  <button id="b" type="submit">Open</button>
  <div id="msg" role="status"></div>
</form>
<script>
(function(){
var SALT="__SALT__",DATA="__DATA__",KEY="__STORAGE_KEY__",DAYS=30;
var enc=new TextEncoder();
function b64(s){return Uint8Array.from(atob(s),function(c){return c.charCodeAt(0)})}
var blob=b64(DATA),iv=blob.slice(0,12),ct=blob.slice(12);
var f=document.getElementById("f"),c=document.getElementById("c"),m=document.getElementById("msg"),b=document.getElementById("b");
function ready(fn){if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",fn);else fn()}
function show(html){ready(function(){setTimeout(function(){document.open();document.write(html);document.close()},0)})}
function dec(key){return crypto.subtle.decrypt({name:"AES-GCM",iv:iv},key,ct).then(function(pt){return new TextDecoder().decode(pt)})}
function fromRaw(raw){return crypto.subtle.importKey("raw",b64(raw),"AES-GCM",false,["decrypt"])}
var saved=null;
try{var s=JSON.parse(localStorage.getItem(KEY)||"null");if(s&&s.k&&Date.now()-s.t<DAYS*864e5)saved=s.k;else if(s)localStorage.removeItem(KEY)}catch(e){}
if(saved){
  f.hidden=true;
  fromRaw(saved).then(dec).then(show,function(){try{localStorage.removeItem(KEY)}catch(e){}f.hidden=false});
}
f.addEventListener("submit",function(e){
  e.preventDefault();m.textContent="";b.disabled=true;
  var code=c.value.toLowerCase().replace(/\s+/g,"");
  crypto.subtle.importKey("raw",enc.encode(code),"PBKDF2",false,["deriveKey"]).then(function(base){
    return crypto.subtle.deriveKey({name:"PBKDF2",salt:b64(SALT),iterations:600000,hash:"SHA-256"},base,{name:"AES-GCM",length:256},true,["decrypt"]);
  }).then(function(key){
    return dec(key).then(function(html){
      return crypto.subtle.exportKey("raw",key).then(function(raw){
        try{localStorage.setItem(KEY,JSON.stringify({k:btoa(String.fromCharCode.apply(null,new Uint8Array(raw))),t:Date.now()}))}catch(e){}
        show(html);
      });
    });
  }).catch(function(){m.textContent="That code did not work.";b.disabled=false;c.select()});
});
})();
</script>
</body>
</html>
`;
