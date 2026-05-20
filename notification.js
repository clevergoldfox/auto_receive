/* Crowdworks Auto Bid — completion popup window.
 * Shows the message passed via ?text= and closes itself after a few seconds. */
const text = new URLSearchParams(location.search).get('text') || '入札が完成しました！';
document.getElementById('msg').textContent = text;
setTimeout(() => window.close(), 5000);
