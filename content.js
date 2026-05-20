/* Crowdworks Auto Bid — content script (runs on crowdworks.jp)
 *
 * Flow, once background.js opens a job page on this tab:
 *   1. Ask background whether this tab has an active bid task.
 *   2. If a proposal form is present  -> fill price + message (and submit).
 *   3. Otherwise click the "apply / 応募する" button to reach the form.
 *
 * IMPORTANT: Crowdworks' DOM differs by job type and changes over time.
 * If bids are not being filled correctly, open the proposal page, inspect the
 * fields with DevTools, and adjust the SELECTORS below.
 */
(function () {
  'use strict';

  const SELECTORS = {
    // Price / contract-amount input on the proposal form.
    amount: [
      'input[name*="amount"]',
      'input[name*="price"]',
      'input[name*="budget"]',
      'input[type="number"]',
    ],
    // Proposal message / body textarea.
    message: [
      'textarea[name*="message"]',
      'textarea[name*="body"]',
      'textarea[name*="condition"]',
      'textarea[name*="proposal"]',
      'textarea',
    ],
    // Visible text on the button that opens the proposal form.
    applyText: ['応募する', 'この仕事に応募', '応募画面', '見積り・提案', '提案する'],
    // Visible text on the final submit button of the proposal form.
    submitText: ['応募する', 'この内容で応募', '提案する', '送信する'],
  };

  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
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

  const attempts = () => parseInt(sessionStorage.getItem('cw-attempts') || '0', 10);
  const bumpAttempts = () => {
    const n = attempts() + 1;
    sessionStorage.setItem('cw-attempts', String(n));
    return n;
  };

  const report = (ok, extra) =>
    chrome.runtime.sendMessage({ type: 'cw-bid-done', ok, ...extra });

  let task = null;

  function fillProposalForm() {
    const amounts = queryAll(SELECTORS.amount);
    const messages = queryAll(SELECTORS.message);
    if (!amounts.length || !messages.length) return false;

    // Prefer the largest visible textarea as the proposal body.
    const body = messages.sort(
      (a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight,
    )[0];

    setValue(amounts[0], String(task.price));
    setValue(body, task.message);

    const submit =
      buttonByText(SELECTORS.submitText) ||
      document.querySelector('input[type="submit"], button[type="submit"]');

    if (task.autoSubmit) {
      if (!submit) return false;
      setTimeout(() => {
        submit.click();
        setTimeout(() => report(true, { filledOnly: false }), 2500);
      }, 800);
    } else {
      report(true, { filledOnly: true }); // filled only — user reviews & submits
    }
    return true;
  }

  function step() {
    if (attempts() > 8) {
      report(false, { error: 'Could not locate the proposal form (too many attempts).' });
      return;
    }
    bumpAttempts();

    if (fillProposalForm()) return;

    const apply = buttonByText(SELECTORS.applyText);
    if (apply) {
      apply.click();          // may navigate to the form, or open it as a modal
      setTimeout(step, 2500); // modal case; a real navigation reloads this script
      return;
    }
    setTimeout(step, 2000);   // form not rendered yet — wait for dynamic content
  }

  function run() {
    chrome.runtime.sendMessage({ type: 'cw-get-task' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.task) return; // not our tab
      task = resp.task;
      step();
    });
  }

  if (/crowdworks\.jp/.test(location.href)) {
    setTimeout(run, 1500);
  }
})();
