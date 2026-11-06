import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureDeBankRequest,
  declaredRequestUrlAddress,
  replayCacheKey,
  replayCacheKeysForAddress,
  capturedMessageAddressForProfile,
  createCancelEnrichMessage,
  createDeBankCaptureRejectedMessage,
  createDeBankReplayRequestMessage,
  createDeBankResponseMessage,
  createEnrichRequestForProfile,
  DAL_MESSAGE_MARK,
  DAL_MESSAGE_VERSION,
  isCurrentEnrichRequest,
  isAcceptedDeBankApiUrl,
  isCancelEnrichMessage,
  isDeBankCaptureRejectedMessage,
  isDeBankReplayRequestMessage,
  isDeBankResponseMessage,
  isEnrichRequestMessage,
  isHistoryListUrl,
  profileAddressFromPath,
  resolveRequestUrl,
} from '../utils/message-protocol.ts';

const USER = '0x000000000000000000000000000000000000f002';
const OTHER_USER = '0x1111111111111111111111111111111111111111';
const API = `https://api.debank.com/portfolio/project_list?id=${USER}`;
const HISTORY_API = `https://api.debank.com/history/list?user_addr=${USER}&chain=&start_time=&page_count=20`;
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';

test('shared message contract accepts only the versioned exact DeBank API boundary', () => {
  const response = {
    [DAL_MESSAGE_MARK]: true,
    version: DAL_MESSAGE_VERSION,
    kind: 'debank-response',
    url: API,
    requestAddress: USER,
    captureSequence: 1,
    data: { data: [] },
  };
  assert.equal(isDeBankResponseMessage(response), true);
  assert.equal(isDeBankResponseMessage({ ...response, version: 1 }), false);
  assert.equal(isDeBankResponseMessage({ ...response, requestAddress: 'not-an-address' }), false);
  assert.equal(isDeBankResponseMessage({ ...response, captureSequence: 0 }), false);
  assert.equal(isDeBankResponseMessage({ ...response, captureSequence: 1.5 }), false);
  const { requestAddress: _requestAddress, ...missingIdentity } = response;
  assert.equal(isDeBankResponseMessage(missingIdentity), false);
  assert.equal(isDeBankResponseMessage({ ...response, url: 'https://api.debank.com.evil.test/portfolio/project_list' }), false);
  assert.equal(isAcceptedDeBankApiUrl('http://api.debank.com/portfolio/project_list'), false);
  assert.equal(isAcceptedDeBankApiUrl(HISTORY_API), true);
  assert.equal(isHistoryListUrl(HISTORY_API), true);
  assert.equal(isHistoryListUrl(API), false);
  assert.equal(isAcceptedDeBankApiUrl('https://api.debank.com/history/list/extra'), false);

  assert.equal(isEnrichRequestMessage({
    type: 'dal:enrich',
    version: DAL_MESSAGE_VERSION,
    requestId: REQUEST_ID,
    url: API,
    data: {},
    address: USER,
  }), true);
  assert.equal(isEnrichRequestMessage({
    type: 'dal:enrich',
    version: DAL_MESSAGE_VERSION,
    requestId: REQUEST_ID,
    url: API,
    data: {},
    address: 'not-an-address',
  }), false);
  assert.equal(isEnrichRequestMessage({
    type: 'dal:enrich',
    version: DAL_MESSAGE_VERSION,
    requestId: 'not-a-request-id',
    url: API,
    data: {},
    address: USER,
  }), false);
  assert.equal(isEnrichRequestMessage({
    type: 'dal:enrich',
    version: DAL_MESSAGE_VERSION,
    requestId: REQUEST_ID,
    url: HISTORY_API,
    data: {},
    address: USER,
  }), false);
});

test('fetch and XHR captures retain the immutable request-time wallet after SPA navigation', () => {
  const pathAtStart = `/profile/${USER}`;
  for (const malformed of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      captureDeBankRequest(API, `https://debank.com${pathAtStart}`, pathAtStart, malformed),
      undefined,
    );
  }
  const fetchCapture = captureDeBankRequest(API, `https://debank.com${pathAtStart}`, pathAtStart, 1);
  const xhrUrlFromOpen = resolveRequestUrl(API, `https://debank.com${pathAtStart}`);
  const xhrCaptureAtSend = captureDeBankRequest(
    xhrUrlFromOpen,
    `https://debank.com${pathAtStart}`,
    pathAtStart,
    2,
  );

  for (const capture of [fetchCapture, xhrCaptureAtSend]) {
    assert.ok(capture);
    assert.equal(capture.requestAddress, USER);
    assert.ok(capture.captureSequence > 0);
    assert.equal(Object.isFrozen(capture), true);
    const delayedResponse = createDeBankResponseMessage(capture, { data: ['wallet-a'] });
    assert.equal(delayedResponse.requestAddress, USER);
    assert.equal(delayedResponse.captureSequence, capture.captureSequence);
    assert.equal(createEnrichRequestForProfile(delayedResponse, OTHER_USER, REQUEST_ID), undefined);
    assert.equal(createEnrichRequestForProfile(delayedResponse, USER, REQUEST_ID)?.address, USER);
  }
});

test('fetch and XHR share the accepted history/list capture boundary without enabling enrich', () => {
  const pathAtStart = `/profile/${USER}/history`;
  const fetchCapture = captureDeBankRequest(
    HISTORY_API,
    `https://debank.com${pathAtStart}`,
    pathAtStart,
    1,
  );
  const xhrCapture = captureDeBankRequest(
    resolveRequestUrl(HISTORY_API, `https://debank.com${pathAtStart}`),
    `https://debank.com${pathAtStart}`,
    pathAtStart,
    2,
  );

  for (const capture of [fetchCapture, xhrCapture]) {
    assert.ok(capture);
    const response = createDeBankResponseMessage(capture, { data: { history_list: [] } });
    assert.equal(isDeBankResponseMessage(response), true);
    assert.equal(createEnrichRequestForProfile(response, USER, REQUEST_ID), undefined);
  }
});

test('bridge rejects missing, mismatched, and URL-conflicting wallet identity before enrichment', () => {
  const capture = captureDeBankRequest(API, `https://debank.com/profile/${USER}`, `/profile/${USER}`, 1);
  assert.ok(capture);
  const valid = createDeBankResponseMessage(capture, { data: [] });
  assert.ok(createEnrichRequestForProfile(valid, USER, REQUEST_ID));
  // SPA 竞态修复(2026-07-12):URL 声明身份为准——请求发出时 pathname 还在搜索页(无快照)
  // 或停在旧地址,只要响应声明的地址等于当前视图地址,必须接受
  assert.equal(createEnrichRequestForProfile({ ...valid, requestAddress: undefined }, USER, REQUEST_ID)?.address, USER);
  assert.equal(createEnrichRequestForProfile({ ...valid, requestAddress: OTHER_USER }, USER, REQUEST_ID)?.address, USER);
  // 安全性质保留:声明身份 ≠ 当前视图 → 拒收(A 的数据绝不渲染到 B 的页面)
  assert.equal(
    createEnrichRequestForProfile(valid, OTHER_USER, REQUEST_ID),
    undefined,
  );
  // URL 携带互相矛盾的地址参数 → 可疑,直接拒收不回退
  assert.equal(
    createEnrichRequestForProfile({ ...valid, url: `${API}&user_addr=${OTHER_USER}` }, USER, REQUEST_ID),
    undefined,
  );
  // URL 无身份参数 → 退回请求时快照语义
  const bareUrl = 'https://api.debank.com/portfolio/project_list';
  assert.equal(
    capturedMessageAddressForProfile({ url: bareUrl, requestAddress: USER }, USER),
    USER,
  );
  assert.equal(capturedMessageAddressForProfile({ url: bareUrl, requestAddress: OTHER_USER }, USER), undefined);
  assert.equal(capturedMessageAddressForProfile({ url: bareUrl, requestAddress: undefined }, USER), undefined);
  assert.equal(createEnrichRequestForProfile(valid, USER, 'not-a-request-id'), undefined);
});

test('cancel messages share the versioned typed request identity', () => {
  const cancel = createCancelEnrichMessage(REQUEST_ID);
  assert.equal(isCancelEnrichMessage(cancel), true);
  assert.equal(isCancelEnrichMessage({ ...cancel, requestId: 'invalid' }), false);
  assert.equal(isCancelEnrichMessage({ ...cancel, version: 2 }), false);
});

test('capture rejection keeps request-time wallet and only invalidates its current profile', () => {
  const capture = captureDeBankRequest(API, `https://debank.com/profile/${USER}`, `/profile/${USER}`, 1);
  assert.ok(capture);
  const rejected = createDeBankCaptureRejectedMessage(capture, 'payload-too-large');
  assert.equal(isDeBankCaptureRejectedMessage(rejected), true);
  assert.equal(rejected.captureSequence, capture.captureSequence);
  assert.equal(capturedMessageAddressForProfile(rejected, USER), USER);
  assert.equal(capturedMessageAddressForProfile(rejected, OTHER_USER), undefined);
  assert.equal(isDeBankCaptureRejectedMessage({ ...rejected, reason: 'unexpected' }), false);
  assert.equal(isDeBankCaptureRejectedMessage({ ...rejected, captureSequence: Number.NaN }), false);
  assert.equal(isDeBankCaptureRejectedMessage({ ...rejected, version: 2 }), false);
});

test('replay requests are versioned, normalized, and bound to one explicit profile', () => {
  const replay = createDeBankReplayRequestMessage(USER.toUpperCase());
  assert.ok(replay);
  assert.equal(replay.requestAddress, USER);
  assert.equal(isDeBankReplayRequestMessage(replay), true);
  assert.equal(isDeBankReplayRequestMessage({ ...replay, requestAddress: OTHER_USER }), true);
  assert.equal(isDeBankReplayRequestMessage({ ...replay, requestAddress: OTHER_USER.toUpperCase() }), false);
  assert.equal(isDeBankReplayRequestMessage({ ...replay, version: 4 }), false);
  assert.equal(isDeBankReplayRequestMessage({ ...replay, kind: 'debank-response' }), false);
  assert.equal(createDeBankReplayRequestMessage('not-an-address'), undefined);
});

test('enrichment request carries only the bounded clone selected by the bridge', () => {
  const capture = captureDeBankRequest(API, `https://debank.com/profile/${USER}`, `/profile/${USER}`, 1);
  assert.ok(capture);
  const unsafe = createDeBankResponseMessage(capture, { unsafe: true });
  const safe = { data: [] };
  const request = createEnrichRequestForProfile(unsafe, USER, REQUEST_ID, safe);
  assert.ok(request);
  assert.equal(request.data, safe);
});

test('post-worker guard rejects a delayed generation and an SPA address change', () => {
  assert.equal(isCurrentEnrichRequest(4, 4, USER, USER), true);
  assert.equal(isCurrentEnrichRequest(3, 4, USER, USER), false);
  assert.equal(isCurrentEnrichRequest(4, 4, USER, OTHER_USER), false);
  assert.equal(isCurrentEnrichRequest(4, 4, USER, undefined), false);
});

test('shared URL and profile helpers normalize without inferring another wallet', () => {
  assert.equal(profileAddressFromPath(`/profile/${USER}`), USER);
  assert.equal(profileAddressFromPath(`/profile/${USER}/`), USER);
  assert.equal(profileAddressFromPath(`/token/${USER}`), undefined);
  assert.equal(
    resolveRequestUrl('/portfolio/project_list', 'https://api.debank.com/base'),
    'https://api.debank.com/portfolio/project_list',
  );
});

test('declared identity is tri-state: present-but-invalid or alias keys never fall back', () => {
  const BASE = 'https://api.debank.com/portfolio/project_list';
  // valid:标准键、重复一致、大小写地址归一、百分号编码
  assert.deepEqual(declaredRequestUrlAddress(`${BASE}?id=${USER}`), { state: 'valid', address: USER });
  assert.deepEqual(declaredRequestUrlAddress(`${BASE}?id=${USER}&user_addr=${USER}`), { state: 'valid', address: USER });
  assert.deepEqual(
    declaredRequestUrlAddress(`${BASE}?id=${USER.toUpperCase().replace('0X', '0x')}`),
    { state: 'valid', address: USER },
  );
  assert.deepEqual(
    declaredRequestUrlAddress(`${BASE}?id=${encodeURIComponent(USER)}`),
    { state: 'valid', address: USER },
  );
  // absent:完全无身份参数才允许回退
  assert.deepEqual(declaredRequestUrlAddress(`${BASE}?chain=eth`), { state: 'absent' });
  // invalid:存在但非法/矛盾/别名键——一律拒收(codex-review 2026-07-12 中危 finding 回归钉)
  for (const url of [
    `${BASE}?id=invalid`,
    `${BASE}?id=`,
    `${BASE}?id=${USER}&user_addr=${OTHER_USER}`,
    `${BASE}?ID=${USER}`,
    `${BASE}?id[]=${USER}`,
    `${BASE}?User_Addr=${USER}`,
    `${BASE}?user_addr[]=${USER}`,
    `${BASE}?id[0]=${USER}`,
    `${BASE}?id[][]=${USER}`,
    `${BASE}?user_addr[wallet]=${USER}`,
    `${BASE}?Id[0]=${USER}`,
  ]) {
    assert.deepEqual(declaredRequestUrlAddress(url), { state: 'invalid' }, url);
    assert.equal(capturedMessageAddressForProfile({ url, requestAddress: USER }, USER), undefined, url);
  }
});

test('replay cache keys follow the same identity adjudication and separate endpoints', () => {
  const PROJECT = `https://api.debank.com/portfolio/project_list?id=${USER}`;
  const HISTORY = `https://api.debank.com/history/list?user_addr=${USER}&chain=`;
  // 身份迁移(codex-review 2026-07-12 中危 finding):SPA 竞态下快照还是旧地址,
  // 缓存键必须跟 URL 声明身份走,否则重放查不到
  assert.equal(replayCacheKey({ url: PROJECT, requestAddress: OTHER_USER }), `${USER}:project`);
  assert.equal(replayCacheKey({ url: PROJECT, requestAddress: undefined }), `${USER}:project`);
  // 端点分槽(高危 finding):history 不得覆盖同地址的 project_list
  assert.equal(replayCacheKey({ url: HISTORY, requestAddress: USER }), `${USER}:history`);
  assert.notEqual(
    replayCacheKey({ url: PROJECT, requestAddress: USER }),
    replayCacheKey({ url: HISTORY, requestAddress: USER }),
  );
  // invalid 身份不缓存;无声明时退快照;快照也没有则不缓存
  assert.equal(replayCacheKey({ url: `${PROJECT}&user_addr=${OTHER_USER}`, requestAddress: USER }), undefined);
  const BARE = 'https://api.debank.com/portfolio/project_list';
  assert.equal(replayCacheKey({ url: BARE, requestAddress: USER }), `${USER}:project`);
  assert.equal(replayCacheKey({ url: BARE, requestAddress: undefined }), undefined);
  assert.deepEqual(replayCacheKeysForAddress(USER), [`${USER}:project`, `${USER}:history`]);
  assert.deepEqual(replayCacheKeysForAddress('not-an-address'), []);
});
