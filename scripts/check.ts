import { parseDocument } from '../src/lib/parser';
import { analyze } from '../src/lib/analyzer';
import { applyStructuralChange } from '../src/lib/rewriter';
import { scanReferences } from '../src/lib/scanner';
import { parseOrdinal, formatChinese } from '../src/lib/numeral';
import { assert } from 'node:console';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`✗ ${name} ${extra}`);
  }
}

// ---- 数字解析 ----
check('中文 一', parseOrdinal('一')?.value === 1);
check('中文 十', parseOrdinal('十')?.value === 10);
check('中文 二十三', parseOrdinal('二十三')?.value === 23);
check('中文 一百零五', parseOrdinal('一百零五')?.value === 105);
check('阿拉伯 12', parseOrdinal('12')?.value === 12);
check('全角 １２', parseOrdinal('１２')?.value === 12);
check('零非法', parseOrdinal('零') === null);
check('格式 23→二十三', formatChinese(23) === '二十三', formatChinese(23));
check('格式 105→一百零五', formatChinese(105) === '一百零五', formatChinese(105));
check('格式 10→十', formatChinese(10) === '十', formatChinese(10));

// ---- 扫描器 ----
const spans = scanReferences(
  '依第五条第二款第（一）项及本条第三款、前款第（二）项、前项、后条、第十二条规定。',
);
const raws = spans.map((s) => s.raw);
check('绝对条款项', raws.includes('第五条第二款第（一）项'), JSON.stringify(raws));
check('本条', raws.includes('本条第三款'), JSON.stringify(raws));
check('前款', raws.some((r) => r.startsWith('前款')), JSON.stringify(raws));
check('前项', raws.includes('前项'), JSON.stringify(raws));
check('后条', raws.includes('后条'), JSON.stringify(raws));
check('第十二条', raws.includes('第十二条'), JSON.stringify(raws));

// ---- 解析 ----
const text = `测试办法

第一条【目的】
为了测试，适用第三条和第四条第一款的规定。

第二条【范围】
本法适用范围如下：
（一）情形一，参见第三条第二款；
（二）情形二，参见前款和第五条。

第三条【程序一】
第一款内容。
本条第二款引用第四条，本条第三款引用第六条造成循环。

第四条【程序二】
本条援引第三条形成循环。
另引用不存在的第二十条。

第五条【附则】
最后一条引用前条。`;

const { doc } = parseDocument(text);
check('解析出 5 条', doc.root.length === 5, String(doc.root.length));
check('标题', doc.title === '测试办法', doc.title);
// 第三条：第一段“第一款内容。”结束后换行，第二段为“本条第二款…循环。”
check('第三条有 2 款', doc.root[2].children.length === 2, String(doc.root[2].children.length));
check('第二条有 1 款 2 项', doc.root[1].children.length === 1 && doc.root[1].children[0].children.length === 2);

let a = analyze(doc, { confirmed: {} });
check('存在断链(第二十条)', a.issues.some((i) => i.type === 'broken' && i.message.includes('二十')), JSON.stringify(a.issues.map(i=>i.message)));
check('存在循环(三<->四)', a.issues.some((i) => i.type === 'cycle'), JSON.stringify(a.issues.map(i=>i.type)));
const okRef = a.occurrences.find((o) => o.span.raw === '第三条');
check('"第三条" 唯一定位', okRef?.resolution.status === 'ok' && okRef.resolution.targetId === doc.root[2].id);
const paraRef = a.occurrences.find((o) => o.span.raw === '第四条第一款');
check('"第四条第一款" 定位到款', paraRef?.resolution.status === 'ok' && paraRef.resolution.targetId === doc.root[3].children[0].id);
check('边数量>0', a.edges.length > 5, String(a.edges.length));

// ---- 原子改写：把第三条移动到末尾（3->5, 4->3, 5->4） ----
const root = doc.root.map((n) => n);
const result = applyStructuralChange(doc, a, (r) => {
  const third = r.splice(2, 1)[0];
  r.push(third);
});
check('改写数量 > 0', result.rewritten > 0, String(result.rewritten));
const a2 = analyze(result.doc, { confirmed: {} });
const texts = JSON.stringify(result.doc);
check('原"第三条"被改写', !texts.includes('适用第三条和'), texts.match(/适用第[^，。]*/)?.[0] ?? '');
check('指向移动条的引用变为第五条', texts.includes('适用第五条'), texts.match(/适用第[^，。]*/)?.[0] ?? '');
// 循环引用应依然存在（三/四换了编号但文本都改写后仍互指）
check('改写后仍检出循环', a2.issues.some((i) => i.type === 'cycle'), JSON.stringify(a2.issues.map(i=>i.type)));
// 断链依然存在
check('断链保留', a2.issues.some((i) => i.type === 'broken'));
// 移动后新位置条
check('移动后原第三条位于第 5 位', result.doc.root[4].id === doc.root[2].id);

// ---- 自引用检测 ----
const selfText = `第一条
本款就是本款。`;
const selfDoc = parseDocument(selfText).doc;
const selfAnalysis = analyze(selfDoc, { confirmed: {} });
check(
  '自引用检出（本项/本款自指）',
  selfAnalysis.issues.some((i) => i.type === 'self'),
  JSON.stringify(selfAnalysis.issues.map((i) => i.message)),
);

// 条内绝对回指本条 → 自引用；相对“本条”不算
const absSelf = parseDocument(`第五条
本条规定按第五条执行。`).doc;
absSelf.root[0].ordinal = 5;
const absSelfA = analyze(absSelf, { confirmed: {} });
const selfCount = absSelfA.issues.filter((i) => i.type === 'self').length;
check('绝对回指本条计 1 次自引用，本条相对引用不计', selfCount === 1, String(selfCount));

// ---- 歧义：同序号条 ----
const amb = parseDocument(`第八条
参见第八条。

第八条之一
补充规定。`).doc;
// parser 不生成后缀，手工标记
amb.root[1].suffix = '一';
const ambA = analyze(amb, { confirmed: {} });
check('同序号歧义', ambA.issues.some((i) => i.type === 'ambiguous'), JSON.stringify(ambA.issues.map(i=>i.message)));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
