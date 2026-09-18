import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import { diffSnapshots } from '../lib/diff';
import type { NodeChange, NodeChangeKind, RefChange } from '../lib/diff';
import type { DocSnapshot, NodeKind, RefStatus } from '../../shared/model';
import { countNodes } from '../lib/parser';

const KIND_LABEL: Record<NodeKind, string> = { article: '条', paragraph: '款', item: '项' };

const CHANGE_META: Record<NodeChangeKind, { label: string; cls: string }> = {
  added: { label: '新增', cls: 'dc-added' },
  removed: { label: '删除', cls: 'dc-removed' },
  modified: { label: '修改', cls: 'dc-modified' },
  moved: { label: '移动', cls: 'dc-moved' },
};

const REF_CHANGE_META: Record<RefChange['change'], { label: string; cls: string }> = {
  added: { label: '引用新增', cls: 'dc-added' },
  removed: { label: '引用移除', cls: 'dc-removed' },
  'target-changed': { label: '目标变化', cls: 'dc-modified' },
};

const STATUS_LABEL: Record<RefStatus, string> = {
  ok: '有效',
  broken: '断链',
  ambiguous: '歧义',
};

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function snippet(text: string | undefined, max = 90): string {
  if (!text) return '（空）';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

export function CompareView({
  onClose,
  onJumpNode,
}: {
  onClose: () => void;
  /** 跳到当前版本中的对应节点（由上层负责切回编辑视图并联动高亮） */
  onJumpNode: (nodeId: string) => void;
}) {
  const { store } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { snapshots, analysis } = store.getSnapshot();

  const [name, setName] = useState('');
  const [aId, setAId] = useState('');
  const [bId, setBId] = useState('');

  // 未显式选择时默认对比最近两个快照
  const base =
    snapshots.find((s) => s.id === aId) ?? snapshots[Math.max(0, snapshots.length - 2)];
  const target = snapshots.find((s) => s.id === bId) ?? snapshots[snapshots.length - 1];

  const diff = useMemo(
    () => (base && target && base.id !== target.id ? diffSnapshots(base, target) : null),
    [base, target],
  );

  const save = () => {
    store.saveSnapshot(name);
    setName('');
  };

  return (
    <div className="compare-view">
      <div className="compare-head">
        <h2>版本对比</h2>
        <button className="close-x" onClick={onClose} aria-label="返回编辑">
          ×
        </button>
      </div>

      <section className="compare-section">
        <h3>快照</h3>
        <div className="snapshot-save-row">
          <input
            className="snapshot-name-input"
            value={name}
            placeholder={`快照名称（默认：快照 ${snapshots.length + 1}）`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
            }}
          />
          <button className="primary" onClick={save}>
            保存当前为快照
          </button>
        </div>
        <p className="compare-hint">
          快照是当前文档的只读副本，随文档一同持久化并包含在导出的 JSON
          中；删除快照不会影响正文、确认记录与撤销历史。
        </p>
        {snapshots.length === 0 ? (
          <div className="empty-hint">还没有快照。保存两个以上快照后即可在此对比版本差异。</div>
        ) : (
          <ul className="snapshot-list">
            {snapshots.map((s) => (
              <SnapshotRow
                key={s.id}
                snapshot={s}
                selected={s.id === base?.id || s.id === target?.id}
                onDelete={() => {
                  if (confirm(`确定删除快照“${s.name}”？正文与撤销历史不受影响。`))
                    store.deleteSnapshot(s.id);
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="compare-section">
        <h3>选择对比版本</h3>
        <div className="compare-selectors">
          <label>
            基准版本
            <SnapshotSelect
              snapshots={snapshots}
              value={base?.id ?? ''}
              onChange={setAId}
            />
          </label>
          <span className="compare-arrow">→</span>
          <label>
            对比版本
            <SnapshotSelect
              snapshots={snapshots}
              value={target?.id ?? ''}
              onChange={setBId}
            />
          </label>
        </div>

        {snapshots.length < 2 && (
          <div className="empty-hint">至少需要两个快照才能对比。</div>
        )}
        {base && target && base.id === target.id && (
          <div className="empty-hint">基准与对比版本相同，请选择两个不同的快照。</div>
        )}

        {diff && base && target && (
          <div className="diff-result">
            <div className="diff-summary">
              <span className="diff-chip dc-added">新增 {diff.summary.added}</span>
              <span className="diff-chip dc-removed">删除 {diff.summary.removed}</span>
              <span className="diff-chip dc-modified">修改 {diff.summary.modified}</span>
              <span className="diff-chip dc-moved">移动 {diff.summary.moved}</span>
              <span className="diff-chip dc-ref">
                引用变化 {diff.summary.refAdded + diff.summary.refRemoved + diff.summary.refTargetChanged}
              </span>
            </div>
            <p className="compare-hint">
              「{base.name}」→「{target.name}」：节点按稳定 ID 对齐，引用按
              源节点 + 引用原文 + 同文序次 对齐；同一节点同时移动且修改时两类变化都会标出。
            </p>

            <h4>条款变化（{diff.nodeChanges.length}）</h4>
            {diff.nodeChanges.length === 0 && (
              <div className="empty-hint">两个版本的结构与正文完全一致。</div>
            )}
            <ul className="diff-list">
              {diff.nodeChanges.map((c) => (
                <NodeChangeRow
                  key={c.nodeId}
                  change={c}
                  inCurrent={Boolean(analysis.nodes[c.nodeId])}
                  onJump={() => onJumpNode(c.nodeId)}
                />
              ))}
            </ul>

            <h4>引用变化（{diff.refChanges.length}）</h4>
            {diff.refChanges.length === 0 && (
              <div className="empty-hint">两个版本的引用及其目标一致。</div>
            )}
            <ul className="diff-list">
              {diff.refChanges.map((c) => (
                <RefChangeRow
                  key={c.signature}
                  change={c}
                  inCurrent={Boolean(analysis.nodes[c.sourceNodeId])}
                  onJump={() => onJumpNode(c.sourceNodeId)}
                />
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

function SnapshotRow({
  snapshot,
  selected,
  onDelete,
}: {
  snapshot: DocSnapshot;
  selected: boolean;
  onDelete: () => void;
}) {
  const counts = countNodes(snapshot.doc);
  return (
    <li className={`snapshot-row ${selected ? 'selected' : ''}`}>
      <div className="snapshot-info">
        <strong>{snapshot.name}</strong>
        <span className="snapshot-meta">
          {fmtTime(snapshot.createdAt)} · {counts.articles} 条 / {counts.paragraphs} 款 /{' '}
          {counts.items} 项 · 只读
        </span>
      </div>
      <button className="danger small" onClick={onDelete} title="删除快照（不影响正文与撤销历史）">
        删除
      </button>
    </li>
  );
}

function SnapshotSelect({
  snapshots,
  value,
  onChange,
}: {
  snapshots: DocSnapshot[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {snapshots.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}（{fmtTime(s.createdAt)}）
        </option>
      ))}
    </select>
  );
}

function NodeChangeRow({
  change,
  inCurrent,
  onJump,
}: {
  change: NodeChange;
  inCurrent: boolean;
  onJump: () => void;
}) {
  return (
    <li className="diff-row">
      <div className="diff-row-head">
        <span className="diff-badges">
          {change.changes.map((k) => (
            <span key={k} className={`diff-chip ${CHANGE_META[k].cls}`}>
              {CHANGE_META[k].label}
            </span>
          ))}
        </span>
        <span className="diff-label">
          {KIND_LABEL[change.nodeKind]} ·{' '}
          {change.changes.includes('added')
            ? change.afterLabel
            : change.changes.includes('removed')
              ? change.beforeLabel
              : change.beforeLabel === change.afterLabel
                ? change.beforeLabel
                : `${change.beforeLabel} → ${change.afterLabel}`}
        </span>
        <span className="diff-actions">
          {inCurrent ? (
            <button className="link-btn" onClick={onJump}>
              → 定位到当前版本
            </button>
          ) : (
            <span className="diff-gone">当前版本已删除</span>
          )}
        </span>
      </div>
      {change.changes.includes('modified') && (
        <div className="diff-texts">
          <div className="diff-text before">前：{snippet(change.beforeText)}</div>
          <div className="diff-text after">后：{snippet(change.afterText)}</div>
        </div>
      )}
      {change.changes.includes('added') && (
        <div className="diff-texts">
          <div className="diff-text after">{snippet(change.afterText)}</div>
        </div>
      )}
      {change.changes.includes('removed') && (
        <div className="diff-texts">
          <div className="diff-text before">{snippet(change.beforeText)}</div>
        </div>
      )}
    </li>
  );
}

function RefChangeRow({
  change,
  inCurrent,
  onJump,
}: {
  change: RefChange;
  inCurrent: boolean;
  onJump: () => void;
}) {
  const meta = REF_CHANGE_META[change.change];
  const sourceLabel = change.afterSourceLabel ?? change.beforeSourceLabel ?? '（未知节点）';
  const targetOf = (label: string | undefined, status: RefStatus | undefined) =>
    label ?? (status ? `（${STATUS_LABEL[status]}）` : '（无目标）');

  return (
    <li className="diff-row">
      <div className="diff-row-head">
        <span className="diff-badges">
          <span className={`diff-chip ${meta.cls}`}>{meta.label}</span>
        </span>
        <span className="diff-label">
          “{change.raw}”
          {change.occurrenceIndex > 1 ? `（第 ${change.occurrenceIndex} 次）` : ''} · 源：
          {sourceLabel}
        </span>
        <span className="diff-actions">
          {inCurrent ? (
            <button className="link-btn" onClick={onJump}>
              → 定位源节点
            </button>
          ) : (
            <span className="diff-gone">当前版本已删除</span>
          )}
        </span>
      </div>
      <div className="diff-texts">
        {change.change !== 'added' && (
          <div className="diff-text before">
            原目标：{targetOf(change.beforeTargetLabel, change.beforeStatus)}
          </div>
        )}
        {change.change !== 'removed' && (
          <div className="diff-text after">
            新目标：{targetOf(change.afterTargetLabel, change.afterStatus)}
          </div>
        )}
      </div>
    </li>
  );
}
