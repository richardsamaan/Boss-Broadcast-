const { _internal } = require('./index.js');
const { sendOneTemplateMessage, withRetry } = _internal;

let pass = 0, fail = 0;
function assert(cond, msg){
  if(cond){ pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

// ---- Mock fetch simulating Meta's real Graph API responses ----
function mockFetch(responses){
  let call = 0;
  const requests = [];
  return {
    fn: async (url, opts) => {
      requests.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
      const r = responses[call++] || responses[responses.length - 1];
      return {
        ok: r.status < 300,
        status: r.status,
        json: async () => r.body
      };
    },
    requests
  };
}

(async () => {
  console.log('\n=== TEST 1: Correct payload shape for an image-header template ===');
  const mock1 = mockFetch([{ status: 200, body: { messages: [{ id: 'wamid.ABC123' }] } }]);
  const messageId = await sendOneTemplateMessage({
    phoneNumberId: '1234567890',
    token: 'fake-token',
    to: '97339002392',
    templateName: 'autumn_promo',
    languageCode: 'en_US',
    headerType: 'image',
    headerLink: 'https://firebasestorage.googleapis.com/fake-poster.jpg',
    bodyParams: ['Ahmed']
  }, mock1.fn);

  const req = mock1.requests[0];
  assert(messageId === 'wamid.ABC123', 'Returns the real WhatsApp message ID from the response');
  assert(req.url === 'https://graph.facebook.com/v22.0/1234567890/messages', 'Calls the correct Graph API endpoint');
  assert(req.headers['Authorization'] === 'Bearer fake-token', 'Sends the bearer token correctly');
  assert(req.body.messaging_product === 'whatsapp', 'messaging_product field present');
  assert(req.body.to === '97339002392', 'Sends to the correct recipient number');
  assert(req.body.template.name === 'autumn_promo', 'Correct template name');
  const headerComp = req.body.template.components.find(c => c.type === 'header');
  assert(headerComp.parameters[0].type === 'image', 'Header component type is image');
  assert(headerComp.parameters[0].image.link === 'https://firebasestorage.googleapis.com/fake-poster.jpg', 'Correct poster link in header');
  const bodyComp = req.body.template.components.find(c => c.type === 'body');
  assert(bodyComp.parameters[0].text === 'Ahmed', 'Customer name correctly inserted into body variable');

  console.log('\n=== TEST 2: Document (PDF) header template ===');
  const mock2 = mockFetch([{ status: 200, body: { messages: [{ id: 'wamid.PDF001' }] } }]);
  await sendOneTemplateMessage({
    phoneNumberId: '1234567890', token: 'fake-token', to: '97339002392',
    templateName: 'catalogue_pdf', languageCode: 'en_US',
    headerType: 'document', headerLink: 'https://example.com/catalogue.pdf', headerFilename: 'Autumn-Catalogue.pdf'
  }, mock2.fn);
  const docHeader = mock2.requests[0].body.template.components.find(c => c.type === 'header');
  assert(docHeader.parameters[0].type === 'document', 'Header type is document for the PDF template');
  assert(docHeader.parameters[0].document.filename === 'Autumn-Catalogue.pdf', 'PDF filename passed through correctly');

  console.log('\n=== TEST 3: A real Meta error (unapproved template) is surfaced clearly, not swallowed ===');
  const mock3 = mockFetch([{ status: 400, body: { error: { message: 'Template name does not exist in the translation.', code: 132001 } } }]);
  let threw = false, errMsg = '';
  try{
    await sendOneTemplateMessage({
      phoneNumberId: '123', token: 'x', to: '973XXXXXXX', templateName: 'not_approved_yet', languageCode: 'en_US'
    }, mock3.fn);
  }catch(e){ threw = true; errMsg = e.message; }
  assert(threw, 'Throws when Meta rejects the template');
  assert(errMsg.includes('does not exist'), 'Error message is Meta\'s real, specific reason — not a generic failure');

  console.log('\n=== TEST 4: Retry logic recovers from a transient 500, then succeeds ===');
  const mock4 = mockFetch([
    { status: 500, body: { error: { message: 'Internal error' } } },
    { status: 500, body: { error: { message: 'Internal error' } } },
    { status: 200, body: { messages: [{ id: 'wamid.RETRY1' }] } }
  ]);
  const retryResult = await withRetry(() => sendOneTemplateMessage({
    phoneNumberId: '123', token: 'x', to: '973XXXXXXX', templateName: 'promo', languageCode: 'en_US'
  }, mock4.fn), { attempts: 3, baseDelayMs: 5 });
  assert(retryResult === 'wamid.RETRY1', 'Succeeds on the 3rd attempt after two transient failures');
  assert(mock4.requests.length === 3, 'Made exactly 3 attempts, not more, not fewer');

  console.log('\n=== TEST 5: A permanent error (bad phone number) does NOT retry pointlessly ===');
  const mock5 = mockFetch([{ status: 400, body: { error: { message: 'Invalid recipient phone number', code: 131030 } } }]);
  let attempts5 = 0;
  try{
    await withRetry(() => { attempts5++; return sendOneTemplateMessage({
      phoneNumberId: '123', token: 'x', to: 'not-a-number', templateName: 'promo', languageCode: 'en_US'
    }, mock5.fn); }, { attempts: 3, baseDelayMs: 5 });
  }catch(e){ /* expected */ }
  assert(attempts5 === 1, 'Does not waste retries on an error retrying can never fix (only 1 attempt made)');

  console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
