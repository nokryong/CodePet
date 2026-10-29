const test = require('node:test');
const assert = require('node:assert/strict');
const {assertReleaseIdentity} = require('../scripts/release-identity');
test('release uploads require matching candidate, checkout, package, tag and draft', () => {
  const sha='a'.repeat(40), other='b'.repeat(40);
  const valid={candidate:sha,head:sha,version:'1.2.1',tag:'v1.2.1',tagCommit:sha,draftCommit:sha,published:false};
  assert.doesNotThrow(()=>assertReleaseIdentity(valid));
  for(const patch of [{candidate:other},{head:other},{tag:'v1.2.2'},{tagCommit:other},{draftCommit:other},{published:true}]) {
    assert.throws(()=>assertReleaseIdentity({...valid,...patch}));
  }
});
