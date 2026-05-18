process.env.NODE_ENV = 'test';

const { __test } = await import('../server.js');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const patch = `
@@ -1,8 +1,8 @@ setup_getdataclass
- if (changed || needbuflen > cbValueMax)
+ if (changed || needbuflen + len_for_wcs_term > cbValueMax)
  {
-     pgdc->ttlbuflen = needbuflen;
+     pgdc->ttlbuflen = needbuflen + len_for_wcs_term;
  }
`;

const fixedLocal = `
static int
setup_getdataclass(SQLLEN * const length_return, const char ** const ptr_return,
    int *needbuflen_return, GetDataClass * const pgdc, const char *neut_str,
    const OID field_type, const SQLSMALLINT fCType,
    const SQLLEN cbValueMax, const ConnectionClass * const conn)
{
    if (changed || needbuflen + len_for_wcs_term > cbValueMax)
    {
        pgdc->ttlbuflen = needbuflen + len_for_wcs_term;
    }
    return COPY_OK;
}
`;

const oldLocal = `
static int
setup_getdataclass(SQLLEN * const length_return, const char ** const ptr_return,
    int *needbuflen_return, GetDataClass * const pgdc, const char *neut_str,
    const OID field_type, const SQLSMALLINT fCType,
    const SQLLEN cbValueMax, const ConnectionClass * const conn)
{
    if (changed || needbuflen > cbValueMax)
    {
        pgdc->ttlbuflen = needbuflen;
    }
    return COPY_OK;
}
`;

const patchInfo = __test.parsePatch(patch);
const fixedSignals = __test.buildLocalPatchSignals(fixedLocal, patchInfo);
const oldSignals = __test.buildLocalPatchSignals(oldLocal, patchInfo);

assert(fixedSignals.exactAddedMatches.length >= 2, 'fixed local code should match added repair lines');
assert(fixedSignals.exactRemovedMatches.length === 0, 'fixed local code should not match removed old lines');
assert(fixedSignals.preClassification.fixStatus === 'ALREADY_FIXED', 'fixed local code should preclassify as ALREADY_FIXED');

assert(oldSignals.exactRemovedMatches.length >= 2, 'old local code should match removed old lines');
assert(oldSignals.exactAddedMatches.length === 0, 'old local code should not match added repair lines');
assert(oldSignals.preClassification.fixStatus === 'NEEDS_FIX', 'old local code should preclassify as NEEDS_FIX');

const fixedAggregate = __test.aggregateRuleBasedPreClassification([
  { gaussdbPath: 'convert.c', localSignals: fixedSignals },
]);
assert(fixedAggregate.fixStatus === 'ALREADY_FIXED', 'fixed local code should aggregate as ALREADY_FIXED');
assert(fixedAggregate.confidence === 'HIGH', 'fixed aggregate should be high confidence');

const oldAggregate = __test.aggregateRuleBasedPreClassification([
  { gaussdbPath: 'convert.c', localSignals: oldSignals },
]);
assert(oldAggregate.fixStatus === 'NEEDS_FIX', 'old local code should aggregate as NEEDS_FIX');
assert(oldAggregate.confidence === 'HIGH', 'old aggregate should be high confidence');

const functionStart = __test.findFunctionDefinitionStart(fixedLocal.split('\n'), 'setup_getdataclass');
assert(functionStart >= 0, 'multi-line C function signature should be detected');

const snippet = __test.extractRelevantSnippet(fixedLocal, patch, patchInfo);
assert(snippet.includes('setup_getdataclass'), 'function snippet should include setup_getdataclass');
assert(snippet.includes('needbuflen + len_for_wcs_term'), 'function snippet should include repair expression');

console.log('analysis selftest passed');
