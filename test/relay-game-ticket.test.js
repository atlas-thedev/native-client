const test = require('node:test');
const assert = require('node:assert');
const { _internals } = require('../server/relay-routes');

const allowed = (method, path) => _internals.gameTicketAllowed(method, path.split('/').filter(Boolean));

test('in-game tickets may react to, edit and delete group messages', () => {
  assert.equal(allowed('POST', 'messages/m1/react'), true);
  assert.equal(allowed('POST', 'messages/m1/edit'), true);
  assert.equal(allowed('POST', 'messages/m1/delete'), true);
  assert.equal(allowed('GET', 'messages/m1/react'), false);
  assert.equal(allowed('POST', 'messages/m1/pin'), false);
});

test('in-game tickets may edit and delete direct messages only', () => {
  assert.equal(allowed('POST', 'dm-messages/m1/edit'), true);
  assert.equal(allowed('POST', 'dm-messages/m1/delete'), true);
  assert.equal(allowed('POST', 'dm-messages/m1/react'), false);
});

test('existing in-game routes are unchanged', () => {
  assert.equal(allowed('POST', 'groups/g1/messages'), true);
  assert.equal(allowed('DELETE', 'groups/g1'), false);
  assert.equal(allowed('POST', 'groups/g1/members'), false);
});
