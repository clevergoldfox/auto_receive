/* Crowdworks Auto Bid — offscreen timer
 *
 * chrome.alarms cannot fire faster than every 30 seconds. This offscreen
 * document runs a normal setInterval and pings the background worker on each
 * tick, enabling polling intervals as low as 1 second.
 */
let timer = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'start-timer') {
    clearInterval(timer);
    timer = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'cw-tick' }).catch(() => {});
    }, Math.max(1000, msg.intervalMs || 1000));
  } else if (msg.type === 'stop-timer') {
    clearInterval(timer);
    timer = null;
  }
});
