/**
 * Inline boot watchdog injected at the top of `<head>`. No dependencies, runs
 * before any other script/link tag so its capture-phase `error` listener is
 * registered before those tags start loading. Two failure signals:
 *   - a script/link `error` event (asset 404/network failure), or
 *   - a 10 s timeout without `window.__privosUiBooted` being set by the app's
 *     own bootstrap once it renders.
 * Either one replaces `#root` (or `document.body`) with a visible retry panel
 * and notifies the host frame via `postMessage` so the Hub can log it.
 */
export const MCP_UI_SHELL_WATCHDOG_SCRIPT = `(function(){
function fail(){
if(window.__privosUiBooted)return;
var root=document.getElementById('root')||document.body;
if(root){root.innerHTML='<div style="font:14px system-ui;padding:24px;text-align:center">App assets unavailable — <button onclick="location.reload()">Retry</button></div>';}
try{parent.postMessage({method:'ui/asset-load-failed'},'*');}catch(e){}
}
window.addEventListener('error',function(e){
var t=e&&e.target;
if(!t||(t.tagName!=='SCRIPT'&&t.tagName!=='LINK'))return;
fail();
},true);
setTimeout(fail,10000);
})();`;
