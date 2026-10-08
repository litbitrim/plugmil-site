(() => {
  const form = document.getElementById('fm');
  const status = document.getElementById('contact-status');
  const submit = document.getElementById('contact-submit');
  let previousPayload = '';
  let requestId = '';
  let busy = false;

  const show = (message, state) => {
    status.textContent = message;
    status.dataset.state = state;
    status.hidden = false;
  };
  const messages = {
    invalid_input: 'Bitte prüfen Sie Name, E-Mail-Adresse, Nachricht und Datenschutzhinweis.',
    rate_limited: 'In kurzer Zeit wurden mehrere Anfragen gesendet. Bitte versuchen Sie es später erneut oder schreiben Sie direkt an litbitrim@gmail.com.',
    body_too_large: 'Die Nachricht ist zu lang. Bitte kürzen Sie sie oder schreiben Sie direkt an litbitrim@gmail.com.',
  };
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const payload = {
      name: form.elements.name.value.trim(),
      email: form.elements.email.value.trim(),
      service: form.elements.service.value,
      message: form.elements.message.value.trim(),
      website: form.elements.website.value,
      privacy: form.elements.privacy.checked,
    };
    const fingerprint = JSON.stringify(payload);
    if (fingerprint !== previousPayload || !requestId) {
      requestId = crypto.randomUUID();
      previousPayload = fingerprint;
    }
    busy = true;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    show('Ihre Anfrage wird übermittelt …', 'pending');
    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, requestId }),
        signal: AbortSignal.timeout(18000),
      });
      const result = await response.json();
      if (response.status !== 202 || result.status !== 'accepted' || result.requestId !== requestId) {
        show(messages[result.error] || 'Der Versand konnte nicht bestätigt werden. Ihre Eingaben bleiben erhalten. Bitte versuchen Sie es erneut oder schreiben Sie direkt an litbitrim@gmail.com.', 'error');
        return;
      }
      show('Ihre Anfrage wurde vom Versanddienst angenommen. Vielen Dank — ich antworte per E-Mail.', 'accepted');
      form.reset();
      requestId = '';
      previousPayload = '';
    } catch {
      show('Der Versand konnte nicht bestätigt werden. Ihre Eingaben bleiben erhalten. Bei einem erneuten Versuch wird dieselbe Anfrage-ID verwendet. Sie erreichen mich auch direkt unter litbitrim@gmail.com.', 'error');
    } finally {
      busy = false;
      submit.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });
})();
