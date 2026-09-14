/**
 * 解析核心测试
 *
 * 从 index.html 里「原样抽出」解析代码来跑，保证测的就是网页实际执行的那份逻辑，
 * 不是另抄一份（抄一份早晚不同步）。
 *
 * 运行：node tests/parse.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'index.html');

function loadCore() {
  const html = fs.readFileSync(HTML, 'utf8');
  const m = html.match(/\/\* ==== PARSE-CORE-START ==== \*\/([\s\S]*?)\/\* ==== PARSE-CORE-END ==== \*\//);
  if (!m) throw new Error('在 index.html 里找不到 PARSE-CORE 标记，测试无法抽取解析核心');
  const src = m[1] + '\nreturn { stripBom, parseLine, parseAccountLine, parseMailboxCredentialLine, splitAccounts, SEP };';
  // eslint-disable-next-line no-new-func
  return new Function('module', 'exports', src)({ exports: {} }, {});
}

const core = loadCore();
const { parseLine, parseAccountLine, parseMailboxCredentialLine, splitAccounts } = core;

/* ---------- 极简断言 ---------- */
let pass = 0;
const fails = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fails.push(`${label}\n     期望: ${e}\n     实际: ${a}`);
}
function ok(cond, label) {
  if (cond) { pass++; return; }
  fails.push(label);
}

/* ---------- 测试用素材（全部为假数据，不含任何真实凭证） ---------- */
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';          // 32 位 base32
const AT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.abc_123-XYZ';
const line = (email, pw, totp, at) =>
  [email, pw, totp, at].filter(v => v !== null).join('----');

/* ---------- 1. 标准四段 ---------- */
{
  const r = parseLine(`demo001@outlook.com----Ab3xK9mQ2pLw----${TOTP}----${AT}`);
  eq(r.status, 'ok', '标准四段：状态应为 ok');
  eq(r.email, 'demo001@outlook.com', '标准四段：邮箱');
  eq(r.password, 'Ab3xK9mQ2pLw', '标准四段：密码');
  eq(r.totp, TOTP, '标准四段：2FA');
  eq(r.at, AT, '标准四段：AT');
}

/* ---------- 2. ★ 密码以「-」结尾（存量号真实存在的坑） ---------- */
{
  // 密码 Abc123xyZ- 结尾带连字符 → 与分隔符连成 5 个连字符
  const raw = `legacy001@hotmail.com----Abc123xyZ-----${TOTP}----${AT}`;
  const r = parseLine(raw);
  eq(r.status, 'ok', '密码尾带 - ：状态应为 ok');
  eq(r.password, 'Abc123xyZ-', '★密码尾带 - ：必须完整保留尾部的 -');
  eq(r.totp, TOTP, '密码尾带 - ：2FA 不能被污染');
  eq(r.at, AT, '密码尾带 - ：AT 不能被污染');
}

/* ---------- 3. 密码中间含连字符 ---------- */
{
  const r = parseLine(`a@b.com----ab-cd-ef----${TOTP}----${AT}`);
  eq(r.password, 'ab-cd-ef', '密码含 - ：必须完整保留');
  eq(r.email, 'a@b.com', '密码含 - ：邮箱不能被截错');
  eq(r.totp, TOTP, '密码含 - ：2FA');
}

/* ---------- 4. 密码含 4 个连续连字符（极端） ---------- */
{
  const r = parseLine(`a@b.com----ab----cd----${TOTP}----${AT}`);
  eq(r.status, 'ok', '密码含 ---- ：应仍能解析');
  eq(r.password, 'ab----cd', '★密码含 ---- ：按第一个分隔符切，密码完整');
}

/* ---------- 5. 三段（无 2FA） ---------- */
{
  const r = parseLine(`plain@outlook.com----Pw123456----${AT}`);
  eq(r.status, 'ok', '三段：状态应为 ok');
  eq(r.password, 'Pw123456', '三段：密码');
  eq(r.totp, '', '三段：2FA 应为空');
  eq(r.at, AT, '三段：AT');
}

/* ---------- 6. 三段 + 密码尾带 - ---------- */
{
  const r = parseLine(`plain@outlook.com----Pw1234-----${AT}`);
  eq(r.status, 'ok', '三段+尾 - ：状态应为 ok');
  eq(r.password, 'Pw1234-', '★三段+尾 - ：密码完整保留');
  eq(r.at, AT, '三段+尾 - ：AT');
}

/* ---------- 7. 非 JWT AT 必须拒绝，不能误把其他字段当 AT ---------- */
{
  const r = parseLine('a@b.com----Pw123456----' + TOTP + '----zzzz1111yyyy2222');
  eq(r.status, 'bad', '非 JWT 的 AT：必须报错');
  eq(r.reason, 'AT 格式不正确（工作台导出的 AT 应以 eyJ 开头，且包含 3 段）', '非 JWT 的 AT：错误原因');
}

/* ---------- 8. 应跳过的行 ---------- */
{
  eq(parseLine('').status, 'skip', '空行应跳过');
  eq(parseLine('   ').status, 'skip', '空白行应跳过');
  eq(parseLine('# 这是注释').status, 'skip', '注释行应跳过');
  eq(parseLine('====').status, 'bad', '任何非空非注释行解析不了，都应如实报错（不静默丢弃）');
  eq(parseLine('坏行没有分隔符').status, 'bad', '乱码行应报错，不能静默吞掉');
  eq(parseLine('邮箱----密码----2FA----AT').status, 'bad', '表头行应判为无法解析');
}

/* ---------- 9. 应判失败的行 ---------- */
{
  eq(parseLine('a@b.com').status, 'bad', '只有邮箱：应失败');
  eq(parseLine('a@b.com----Pw123456').status, 'bad', '缺 AT：应失败');
  const missingAt = parseLine(`a@b.com----Pw123456----${TOTP}`);
  eq(missingAt.status, 'bad', '邮箱+密码+2FA、缺 AT：应失败');
  eq(missingAt.reason, '缺少 AT：末尾是 2FA 密钥', '邮箱+密码+2FA、缺 AT：应给出准确原因');
  eq(parseLine(`noemail----Pw123456----${TOTP}----${AT}`).status, 'bad', '邮箱无 @：应失败');
  eq(parseLine(`a@b.com--------${TOTP}----${AT}`).status, 'bad', '密码为空：应失败');
  eq(parseLine(`a@b.com----Pw123456----${TOTP}${AT}`).status, 'bad', 'AT 前缺少分隔符：应失败');
}

/* ---------- 10. 工作台邮箱凭证 + AT ---------- */
{
  // refresh_token 里允许继续出现分隔符；拆分后凭证必须逐字符保持原样。
  const credential = 'mail001@outlook.com----MailboxPass----11112222-3333-4444-5555-666677778888----refresh-part-a----refresh-part-b';
  const raw = credential + '----' + AT;
  const r = parseMailboxCredentialLine(raw);
  eq(r.status, 'ok', '邮箱凭证+AT：状态应为 ok');
  eq(r.email, 'mail001@outlook.com', '邮箱凭证+AT：邮箱');
  eq(r.credential, credential, '邮箱凭证+AT：完整凭证必须原样保留');
  eq(r.at, AT, '邮箱凭证+AT：AT');
  eq(parseLine(raw, 'mailbox').credential, credential, '统一入口：mailbox 模式应走邮箱凭证解析');
  const wrongAccountMode = parseAccountLine(raw);
  eq(wrongAccountMode.status, 'bad', '邮箱凭证误选账号模式：必须拒绝');
  eq(wrongAccountMode.reason, '检测到完整邮箱凭证，请选择「完整邮箱凭证----AT」格式', '邮箱凭证误选账号模式：提示切换格式');
  eq(wrongAccountMode.expectedFormat, 'mailbox', '邮箱凭证误选账号模式：标记正确模式');
  const wholeWrongMode = splitAccounts(raw, 'account');
  eq(wholeWrongMode.formatMismatches.length, 1, '邮箱凭证误选账号模式：整段结果应标记格式错误');
  eq(parseMailboxCredentialLine(credential + AT).status, 'bad', '邮箱凭证+AT：AT 前缺分隔符应失败');
  eq(parseMailboxCredentialLine('mail001@outlook.com----MailboxPass--------refresh----' + AT).status,
     'bad', '邮箱凭证+AT：缺 client_id 应失败');

  const text = [raw, '# 注释', '坏行', raw].join('\n');
  const res = splitAccounts(text, 'mailbox');
  eq(res.format, 'mailbox', '邮箱凭证+AT：结果应标记 mailbox 格式');
  eq(res.okCount, 2, '邮箱凭证+AT：成功条数');
  eq(res.skipCount, 1, '邮箱凭证+AT：注释应跳过');
  eq(res.badCount, 1, '邮箱凭证+AT：坏行应报错');
  eq(res.fileA.split('\r\n').filter(Boolean)[0], credential, '邮箱凭证+AT：文件 1 内容');
  eq(res.fileB.split('\r\n').filter(Boolean)[0], AT, '邮箱凭证+AT：文件 2 内容');
  eq(res.fileBad, '坏行\r\n', '邮箱凭证+AT：失败原始行文件应逐行保留原文');
}

/* ---------- 11. 账密格式误选邮箱凭证模式 ---------- */
{
  const raw = `demo001@outlook.com----Ab3xK9mQ2pLw----${TOTP}----${AT}`;
  const r = parseMailboxCredentialLine(raw);
  eq(r.status, 'bad', '账密误选邮箱凭证模式：必须拒绝');
  eq(r.reason, '检测到账密格式，请选择「邮箱----密码----2FA密钥----AT」格式', '账密误选邮箱凭证模式：提示切换格式');
  eq(r.expectedFormat, 'account', '账密误选邮箱凭证模式：标记正确模式');
}

/* ---------- 12. 整段拆分：计数与行对应 ---------- */
{
  const text = [
    `u1@outlook.com----Pw1a2b3c4d5e----${TOTP}----${AT}`,
    '',
    '# 注释',
    `u2@outlook.com----Pw2a2b3c4d5e----${TOTP}----${AT}`,
    '坏行没有分隔符',
    `u3@outlook.com----Pw3a2b3c4d5e----${TOTP}----${AT}`
  ].join('\n');

  const res = splitAccounts(text);
  eq(res.okCount, 3, '整段：成功 3 条');
  eq(res.skipCount, 2, '整段：跳过 2 条（空行 + 注释）');
  eq(res.badCount, 1, '整段：失败 1 条');
  eq(res.countA, 3, '整段：文件 1 行数');
  eq(res.countB, 3, '整段：文件 1/2 行数必须一致');
  eq(res.fileA.split('\r\n').filter(Boolean)[0],
     `u1@outlook.com----Pw1a2b3c4d5e----${TOTP}`,
     '整段：文件 1 应是「邮箱----密码----2FA」');
  eq(res.fileB.split('\r\n').filter(Boolean)[0], AT, '整段：文件 2 应是 AT');
  ok(res.fileA.indexOf('----' + AT) < 0, '整段：文件 1 里不能残留 AT');
  ok(res.fileB.split('\r\n').filter(Boolean).every(l => l === AT), '整段：文件 2 每行只有 AT');
  /* 界面要拿 issues 渲染「无法解析的行」列表，漏返回就是运行时崩溃 */
  ok(Array.isArray(res.issues), '整段：必须返回 issues 数组（界面依赖它）');
  eq(res.issues.length, 1, '整段：issues 明细条数');
  eq(res.issues[0].lineNo, 5, '整段：issues 应带正确行号');
  eq(res.issues[0].reason, '找不到「----AT」分隔符', '整段：issues 应带失败原因');
}

/* ---------- 13. 失败行不写入下载文件 ---------- */
{
  const text = [
    `u1@outlook.com----Pw1a2b3c4d5e----${TOTP}----${AT}`,
    '坏行',
    `u2@outlook.com----Pw2a2b3c4d5e----${TOTP}----${AT}`
  ].join('\n');

  const res = splitAccounts(text);
  eq(res.countA, 2, '失败行：文件 1 只有成功行');
  eq(res.countB, 2, '失败行：文件 2 只有成功行');
  eq(res.issues.length, 1, '失败行：应显示在错误列表');
  eq(res.issues[0].lineNo, 2, '失败行：应保留原始行号');
  eq(res.fileBad, '坏行\r\n', '失败行：导出文件应只包含原始坏行');
}

/* ---------- 14. BOM / 换行符 / 末尾无换行 ---------- */
{
  const text = '\uFEFF' + `u1@outlook.com----Pw1a2b3c4d5e----${TOTP}----${AT}`;
  const r = splitAccounts(text);
  eq(r.okCount, 1, 'BOM：应被剥掉且解析成功');
  eq(r.rows[0].status === 'ok' && r.rows[0].email, 'u1@outlook.com', 'BOM：邮箱没被污染');

  const crlf = `u1@outlook.com----Pw1a2b3c4d5e----${TOTP}----${AT}\r\nu2@outlook.com----Pw2a2b3c4d5e----${TOTP}----${AT}`;
  eq(splitAccounts(crlf).okCount, 2, 'CRLF：两行都能解析');
  eq(splitAccounts(crlf + '\r\n').okCount, 2, 'CRLF+末尾换行：不多算行');
  eq(splitAccounts(crlf + '\r\n').skipCount, 0, '末尾换行：不应算作空行 / 注释');
}

/* ---------- 15. 非 ASCII 邮箱（国际域名） ---------- */
{
  const r = parseLine(`测试@outlook.com----Pw1a2b3c4d5e----${TOTP}----${AT}`);
  eq(r.status, 'ok', '非 ASCII 邮箱：应能解析');
  eq(r.email, '测试@outlook.com', '非 ASCII 邮箱：内容正确');
}

/* ---------- 输出 ---------- */
console.log('');
if (fails.length) {
  console.log(`✗ 解析核心测试：${pass} 通过 / ${fails.length} 失败\n`);
  fails.forEach((f, i) => console.log(`  ${i + 1}. ${f}\n`));
  process.exit(1);
} else {
  console.log(`✓ 解析核心测试全部通过：${pass}/${pass}`);
}
