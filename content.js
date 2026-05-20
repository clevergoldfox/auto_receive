/* Crowdworks Auto Bid — content script (runs on crowdworks.jp)
 *
 * Flow, once background.js opens a job page on this tab:
 *   1. Ask background whether this tab has an active bid task.
 *   2. If a proposal form is present  -> fill price + message (and submit).
 *   3. Otherwise click the "apply / 応募する" button to reach the form.
 *
 * If the form cannot be located, the script dumps the page's inputs / buttons
 * into the extension activity log (via "cw-log") so the SELECTORS below can be
 * corrected. Crowdworks' DOM differs by job type and changes over time.
 */
(function () {
  'use strict';

  const SELECTORS = {
    // Price / contract-amount input on the proposal form.
    amount: [
      'input[name*="amount"]',
      'input[name*="price"]',
      'input[name*="budget"]',
      'input[name*="reward"]',
      'input[type="number"]',
    ],
    // Proposal message / body textarea.
    message: [
      'textarea[name*="message"]',
      'textarea[name*="body"]',
      'textarea[name*="condition"]',
      'textarea[name*="proposal"]',
      'textarea[name*="comment"]',
      'textarea',
    ],
    // Visible text on a button that moves toward / opens the proposal form.
    applyText: ['応募する', 'この仕事に応募', '応募画面', '見積り・提案', '提案する', '次へ'],
    // Visible text on the final submit button of the proposal form.
    submitText: ['応募する', 'この内容で応募', '提案する', '送信する'],
  };

  const MAX_TICKS = 14; // ~28s of retries per page

  /* ----------------------------- helpers ------------------------------ */

  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };

  const queryAll = (selectors) => {
    for (const sel of selectors) {
      const els = [...document.querySelectorAll(sel)].filter(isVisible);
      if (els.length) return els;
    }
    return [];
  };

  const buttonByText = (texts) => {
    const els = [
      ...document.querySelectorAll('button, a, input[type="submit"], input[type="button"]'),
    ].filter(isVisible);
    for (const t of texts) {
      const hit = els.find((e) => (e.innerText || e.value || '').trim().includes(t));
      if (hit) return hit;
    }
    return null;
  };

  // React-friendly value setter (dispatches input/change so frameworks notice).
  const setValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const cwLog = (msg, level) =>
    chrome.runtime.sendMessage({ type: 'cw-log', msg, level }).catch(() => {});
  const report = (ok, extra) =>
    chrome.runtime.sendMessage({ type: 'cw-bid-done', ok, ...extra }).catch(() => {});

  // Dumps the page's form-relevant elements into the activity log.
  function describePage() {
    const label = (el) =>
      el.getAttribute('name') || el.id || el.getAttribute('placeholder') ||
      el.getAttribute('aria-label') || '?';
    const tas = [...document.querySelectorAll('textarea')].filter(isVisible).map(label);
    const nums = [...document.querySelectorAll('input[type=number]')].filter(isVisible).map(label);
    const txts = [...document.querySelectorAll('input[type=text]')].filter(isVisible).map(label);
    const btns = [...document.querySelectorAll('button, input[type=submit], input[type=button], a')]
      .filter(isVisible)
      .map((e) => (e.innerText || e.value || '').trim())
      .filter((t) => t && t.length < 30)
      .slice(0, 30);
    cwLog(`DIAG url: ${location.href}`, 'warn');
    cwLog(`DIAG textareas (${tas.length}): ${tas.join(' | ') || 'none'}`, 'warn');
    cwLog(`DIAG number inputs (${nums.length}): ${nums.join(' | ') || 'none'}`, 'warn');
    cwLog(`DIAG text inputs (${txts.length}): ${txts.join(' | ') || 'none'}`, 'warn');
    cwLog(`DIAG buttons/links: ${btns.join(' / ') || 'none'}`, 'warn');
  }

  const isLoginWall = () =>
    !!document.querySelector('input[type=password]') || /\/login|sign_in/.test(location.href);

  /* ------------------------------ logic ------------------------------- */

  let task = null;
  let ticks = 0;

  function tryFillForm() {
    const amounts = queryAll(SELECTORS.amount);
    const messages = queryAll(SELECTORS.message);
    if (!amounts.length || !messages.length) return false;

    // Prefer the largest visible textarea as the proposal body.
    const body = messages.sort(
      (a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight,
    )[0];

    setValue(amounts[0], String(task.price));
    setValue(body, task.message);
    cwLog(`Form found — filled amount field "${amounts[0].name || amounts[0].id || '?'}" ` +
          `and textarea "${body.name || body.id || '?'}".`);

    const submit =
      buttonByText(SELECTORS.submitText) ||
      document.querySelector('input[type=submit], button[type=submit]');

    if (task.autoSubmit) {
      if (!submit) {
        cwLog('Fields filled but no submit button found.', 'warn');
        report(false, { error: 'Submit button not found.' });
        return true;
      }
      setTimeout(() => {
        submit.click();
        setTimeout(() => report(true, { filledOnly: false }), 2500);
      }, 800);
    } else {
      report(true, { filledOnly: true }); // filled only — user reviews & submits
    }
    return true;
  }

  function tick() {
    ticks++;

    if (isLoginWall()) {
      report(false, { error: 'Not logged in to Crowdworks (login page detected).' });
      return;
    }
    if (tryFillForm()) return;

    if (ticks >= MAX_TICKS) {
      cwLog('Could not locate the proposal form — dumping page contents:', 'warn');
      describePage();
      report(false, { error: 'Could not locate the proposal form.' });
      return;
    }

    // Click an apply / next button once per page (tracked per URL path).
    const pathKey = 'cw-applied:' + location.pathname;
    if (!sessionStorage.getItem(pathKey)) {
      const apply = buttonByText(SELECTORS.applyText);
      if (apply) {
        sessionStorage.setItem(pathKey, '1');
        cwLog(`Clicking button: "${(apply.innerText || apply.value || '').trim()}"`);
        apply.click();          // may navigate to the form, or open it as a modal
        setTimeout(tick, 3000);
        return;
      }
    }
    setTimeout(tick, 2000);     // form not rendered yet — wait for dynamic content
  }

  function run() {
    chrome.runtime.sendMessage({ type: 'cw-get-task' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.task) return; // not our tab
      task = resp.task;
      cwLog(`Bidding started on ${location.href}`);
      tick();
    });
  }

  if (/crowdworks\.jp/.test(location.href)) {
    setTimeout(run, 1800);
  }
})();
