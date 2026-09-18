import { parseDocument } from '../src/lib/parser';
import { analyze } from '../src/lib/analyzer';
import { applyStructuralChange } from '../src/lib/rewriter';
import { scanReferences } from '../src/lib/scanner';
import { parseOrdinal, formatChinese } from '../src/lib/numeral';
import { diffSnapshots } from '../src/lib/diff';
import { cloneTree, newArticle, renumberAll } from '../src/lib/tree';
import { AppStore } from '../src/lib/store';
import type { DocSnapshot } from '../shared/model';
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

// ---- 版本对比：快照 diff（稳定节点 ID 对齐） ----
const diffBase = parseDocument(`对比办法

第一条【目的】
为了测试，适用第二条的规定。

第二条【范围】
本法适用于测试场景。
引用第三条规定处理。

第三条【程序】
程序内容一。
程序内容二，参见第一条。`).doc;
const snapA: DocSnapshot = { id: 'sa', name: 'A', createdAt: 1, doc: diffBase, confirmed: {} };

// 版本 B：第三条移到第二位并修改其正文；删除原第二条第二款；末尾新增一条
const rootB = cloneTree(diffBase.root);
const [movedArt] = rootB.splice(2, 1);
rootB.splice(1, 0, movedArt);
movedArt.text = '本条已整体修订。';
const removedPar = rootB[2].children[1];
rootB[2].children.splice(1, 1);
const addedArt = newArticle('新增条款，引用第一条。');
rootB.push(addedArt);
renumberAll(rootB);
const snapB: DocSnapshot = {
  id: 'sb',
  name: 'B',
  createdAt: 2,
  doc: { ...diffBase, root: rootB },
  confirmed: {},
};
const vd = diffSnapshots(snapA, snapB);

const movedChange = vd.nodeChanges.find((c) => c.nodeId === movedArt.id);
check(
  '移动且修改的节点同时保留两类变化',
  Boolean(
    movedChange &&
      movedChange.changes.includes('moved') &&
      movedChange.changes.includes('modified'),
  ),
  JSON.stringify(movedChange?.changes),
);
check(
  '删除的款被标出',
  vd.nodeChanges.some((c) => c.nodeId === removedPar.id && c.changes.includes('removed')),
);
check(
  '新增的条被标出',
  vd.nodeChanges.some((c) => c.nodeId === addedArt.id && c.changes.includes('added')),
);
check(
  '位置移动被标出（原第二条后移一位）',
  vd.nodeChanges.some((c) => c.nodeId === diffBase.root[1].id && c.changes.includes('moved')),
);
check(
  '未变化的节点不产生差异',
  !vd.nodeChanges.some((c) => c.nodeId === diffBase.root[0].id),
);
check(
  '引用目标变化（“第二条”因换位指向新节点）',
  vd.refChanges.some(
    (c) =>
      c.change === 'target-changed' &&
      c.raw === '第二条' &&
      c.beforeTargetId === diffBase.root[1].id &&
      c.afterTargetId === movedArt.id,
  ),
  JSON.stringify(vd.refChanges),
);
check(
  '引用移除（源节点随款删除）',
  vd.refChanges.some(
    (c) => c.change === 'removed' && c.raw === '第三条' && c.sourceNodeId === removedPar.id,
  ),
);
check(
  '引用新增（新条款中的引用）',
  vd.refChanges.some(
    (c) => c.change === 'added' && c.raw === '第一条' && c.sourceNodeId === addedArt.id,
  ),
);
check(
  '未变化的引用不产生差异',
  !vd.refChanges.some((c) => c.sourceNodeId === movedArt.children[1].id),
);

// ---- 快照存储行为：只读、独立于撤销历史、随 JSON 导入导出 ----
const storeDoc = parseDocument(`快照办法

第一条
内容一，引用第二条。

第二条
内容二。`).doc;
const st = new AppStore({ doc: storeDoc, confirmed: {} });
st.saveSnapshot('v1');
check('保存快照不产生撤销历史', st.getSnapshot().canUndo === false);
check('快照列表有一条', st.getSnapshot().snapshots.length === 1);

const parId = storeDoc.root[0].children[0].id;
st.updateNodeText(parId, '内容一（已修改），引用第二条。');
check('正文编辑进入撤销历史', st.getSnapshot().canUndo === true);
check(
  '快照只读：正文修改后快照内容不变',
  st.getSnapshot().snapshots[0].doc.root[0].children[0].text === '内容一，引用第二条。',
);

const docBeforeDelete = st.getSnapshot().doc;
st.deleteSnapshot(st.getSnapshot().snapshots[0].id);
check('删除快照后列表为空', st.getSnapshot().snapshots.length === 0);
check('删除快照不影响正文', st.getSnapshot().doc === docBeforeDelete);
check('删除快照不影响撤销历史', st.getSnapshot().canUndo === true);
st.undo();
check(
  '删除快照后撤销仍正常工作',
  st.getSnapshot().doc.root[0].children[0].text === '内容一，引用第二条。',
);

// 导出包含快照；导入旧数据（无 snapshots 字段）按空列表加载
st.saveSnapshot('基线');
const bundle = st.exportJson();
check(
  '导出 JSON 包含快照',
  Array.isArray(bundle.snapshots) && bundle.snapshots.length === 1,
);
const st2 = new AppStore({ doc: storeDoc, confirmed: {} });
st2.saveSnapshot('将被覆盖');
st2.importJson({
  app: 'clause-reference-validator',
  version: 1,
  document: storeDoc,
  confirmed: {},
  exportedAt: new Date().toISOString(),
});
check('旧数据缺少 snapshots 时按空列表加载', st2.getSnapshot().snapshots.length === 0);
st2.importJson(bundle);
check(
  '导入 JSON 恢复快照',
  st2.getSnapshot().snapshots.length === 1 &&
    st2.getSnapshot().snapshots[0].name === '基线',
);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
