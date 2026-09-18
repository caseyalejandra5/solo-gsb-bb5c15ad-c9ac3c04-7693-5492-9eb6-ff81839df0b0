// 版本对比：以稳定节点 ID 对齐两个快照，产出节点级与引用级差异
import type {
  ClauseDocument,
  ClauseNode,
  DocSnapshot,
  NodeKind,
  RefStatus,
} from '../../shared/model';
import { analyze } from './analyzer';
import { formatOrdinal } from './numeral';

export type NodeChangeKind = 'added' | 'removed' | 'modified' | 'moved';

export interface NodeChange {
  nodeId: string;
  nodeKind: NodeKind;
  /** 同一节点可同时携带多类变化（如移动且修改），两类都保留 */
  changes: NodeChangeKind[];
  /** 在基准版本中的结构定位，如“第五条第二款” */
  beforeLabel: string;
  /** 在对比版本中的结构定位 */
  afterLabel: string;
  beforeText?: string;
  afterText?: string;
}

export type RefChangeKind = 'added' | 'removed' | 'target-changed';

export interface RefChange {
  /** 对齐签名：源节点 ID + 引用原文 + 同文序次 */
  signature: string;
  change: RefChangeKind;
  sourceNodeId: string;
  raw: string;
  occurrenceIndex: number;
  beforeSourceLabel?: string;
  afterSourceLabel?: string;
  beforeTargetId?: string;
  afterTargetId?: string;
  beforeTargetLabel?: string;
  afterTargetLabel?: string;
  beforeStatus?: RefStatus;
  afterStatus?: RefStatus;
}

export interface VersionDiff {
  nodeChanges: NodeChange[];
  refChanges: RefChange[];
  summary: {
    added: number;
    removed: number;
    modified: number;
    moved: number;
    refAdded: number;
    refRemoved: number;
    refTargetChanged: number;
  };
}

interface FlatEntry {
  node: ClauseNode;
  parentId: string | null;
  /** 在同级兄弟中的下标（从 0 开始） */
  index: number;
  /** 人类可读结构定位 */
  label: string;
}

/** 扁平化文档：id → 位置与标签（标签按结构位置生成，与正文编号无关） */
function flattenDoc(doc: ClauseDocument): Map<string, FlatEntry> {
  const map = new Map<string, FlatEntry>();
  doc.root.forEach((article, ai) => {
    const aLabel = `第${formatOrdinal(article.ordinal)}条${article.suffix ? `之${article.suffix}` : ''}`;
    map.set(article.id, { node: article, parentId: null, index: ai, label: aLabel });
    article.children.forEach((paragraph, pi) => {
      const pLabel = `${aLabel}第${formatOrdinal(pi + 1)}款`;
      map.set(paragraph.id, { node: paragraph, parentId: article.id, index: pi, label: pLabel });
      paragraph.children.forEach((item, ii) => {
        const iLabel = `${pLabel}第${formatOrdinal(ii + 1)}项`;
        map.set(item.id, { node: item, parentId: paragraph.id, index: ii, label: iLabel });
      });
    });
  });
  return map;
}

/** 正文或条标题/后缀发生变化均视为内容修改 */
function contentChanged(a: ClauseNode, b: ClauseNode): boolean {
  return (
    a.text !== b.text ||
    (a.title ?? '') !== (b.title ?? '') ||
    (a.suffix ?? '') !== (b.suffix ?? '')
  );
}

function targetLabel(flat: Map<string, FlatEntry>, targetId: string | undefined): string | undefined {
  if (!targetId) return undefined;
  return flat.get(targetId)?.label;
}

/**
 * 对比两个快照（a 为基准，b 为对比版本）。
 * 节点按稳定 ID 对齐；引用按 signature（源节点 ID + 引用原文 + 同文序次）对齐。
 */
export function diffSnapshots(a: DocSnapshot, b: DocSnapshot): VersionDiff {
  const fa = flattenDoc(a.doc);
  const fb = flattenDoc(b.doc);

  const nodeChanges: NodeChange[] = [];

  // 基准版本中的节点：删除 或 （修改/移动）
  for (const [id, ea] of fa) {
    const eb = fb.get(id);
    if (!eb) {
      nodeChanges.push({
        nodeId: id,
        nodeKind: ea.node.kind,
        changes: ['removed'],
        beforeLabel: ea.label,
        afterLabel: '',
        beforeText: ea.node.text,
      });
      continue;
    }
    const changes: NodeChangeKind[] = [];
    if (contentChanged(ea.node, eb.node)) changes.push('modified');
    if (ea.parentId !== eb.parentId || ea.index !== eb.index) changes.push('moved');
    if (changes.length > 0) {
      nodeChanges.push({
        nodeId: id,
        nodeKind: ea.node.kind,
        changes,
        beforeLabel: ea.label,
        afterLabel: eb.label,
        beforeText: ea.node.text,
        afterText: eb.node.text,
      });
    }
  }

  // 仅存在于对比版本的节点：新增
  for (const [id, eb] of fb) {
    if (fa.has(id)) continue;
    nodeChanges.push({
      nodeId: id,
      nodeKind: eb.node.kind,
      changes: ['added'],
      beforeLabel: '',
      afterLabel: eb.label,
      afterText: eb.node.text,
    });
  }

  // 引用差异：按 signature 对齐（源节点 ID + 引用原文 + 同文序次）
  const analysisA = analyze(a.doc, { confirmed: a.confirmed });
  const analysisB = analyze(b.doc, { confirmed: b.confirmed });
  const occA = new Map(analysisA.occurrences.map((o) => [o.signature, o]));
  const occB = new Map(analysisB.occurrences.map((o) => [o.signature, o]));

  const refChanges: RefChange[] = [];
  for (const [signature, oa] of occA) {
    const ob = occB.get(signature);
    const beforeSourceLabel = fa.get(oa.nodeId)?.label;
    if (!ob) {
      refChanges.push({
        signature,
        change: 'removed',
        sourceNodeId: oa.nodeId,
        raw: oa.span.raw,
        occurrenceIndex: oa.occurrenceIndex,
        beforeSourceLabel,
        beforeTargetId: oa.resolution.targetId,
        beforeTargetLabel: targetLabel(fa, oa.resolution.targetId),
        beforeStatus: oa.resolution.status,
      });
      continue;
    }
    const ta = oa.resolution.targetId;
    const tb = ob.resolution.targetId;
    if (ta !== tb) {
      refChanges.push({
        signature,
        change: 'target-changed',
        sourceNodeId: oa.nodeId,
        raw: oa.span.raw,
        occurrenceIndex: oa.occurrenceIndex,
        beforeSourceLabel,
        afterSourceLabel: fb.get(ob.nodeId)?.label,
        beforeTargetId: ta,
        afterTargetId: tb,
        beforeTargetLabel: targetLabel(fa, ta),
        afterTargetLabel: targetLabel(fb, tb),
        beforeStatus: oa.resolution.status,
        afterStatus: ob.resolution.status,
      });
    }
  }
  for (const [signature, ob] of occB) {
    if (occA.has(signature)) continue;
    refChanges.push({
      signature,
      change: 'added',
      sourceNodeId: ob.nodeId,
      raw: ob.span.raw,
      occurrenceIndex: ob.occurrenceIndex,
      afterSourceLabel: fb.get(ob.nodeId)?.label,
      afterTargetId: ob.resolution.targetId,
      afterTargetLabel: targetLabel(fb, ob.resolution.targetId),
      afterStatus: ob.resolution.status,
    });
  }

  const count = (kind: NodeChangeKind) =>
    nodeChanges.filter((c) => c.changes.includes(kind)).length;

  return {
    nodeChanges,
    refChanges,
    summary: {
      added: count('added'),
      removed: count('removed'),
      modified: count('modified'),
      moved: count('moved'),
      refAdded: refChanges.filter((r) => r.change === 'added').length,
      refRemoved: refChanges.filter((r) => r.change === 'removed').length,
      refTargetChanged: refChanges.filter((r) => r.change === 'target-changed').length,
    },
  };
}
