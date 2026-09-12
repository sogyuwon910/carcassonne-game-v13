// 기록 스냅샷끼리 객체를 공유하지 않도록 JSON 데이터로 한 번 더 깊게 복사합니다.
export function cloneHistoryData(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

// 한 줄 기록 대신 부모와 여러 자식을 가진 트리를 사용해 과거 진행을 지우지 않습니다.
export class HistoryTree {
  constructor() { this.reset(); }

  reset() {
    this.nodes = new Map();
    this.rootId = null;
    this.currentId = null;
    this.liveNodeId = null;
    this.nextNodeNumber = 1;
    this.nextBranchNumber = 1;
    this.pendingBranch = false;
  }

  get currentNode() { return this.nodes.get(this.currentId) ?? null; }
  get liveNode() { return this.nodes.get(this.liveNodeId) ?? null; }
  get isReviewing() { return Boolean(this.currentId && this.currentId !== this.liveNodeId); }
  get canGoPrevious() { return Boolean(!this.pendingBranch && this.currentNode?.parentId); }
  get canGoNext() { return Boolean(!this.pendingBranch && this.currentNode?.children.length); }

  initialize(snapshot, label = "게임 시작") {
    this.reset();
    const node = this.createNode({ snapshot, label, parentId: null, branchId: "original", branchKind: "original", branchLabel: "원래 기록" });
    this.rootId = node.id;
    this.currentId = node.id;
    this.liveNodeId = node.id;
    return node;
  }

  createNode({ snapshot, label, parentId, branchId, branchKind, branchLabel }) {
    const parent = parentId ? this.nodes.get(parentId) : null;
    const node = {
      id: `history-${this.nextNodeNumber++}`,
      parentId,
      children: [],
      depth: parent ? parent.depth + 1 : 0,
      label,
      branchId,
      branchKind,
      branchLabel,
      snapshot: cloneHistoryData(snapshot),
    };
    this.nodes.set(node.id, node);
    if (parent) parent.children.push(node.id);
    return node;
  }

  // 과거 기록에서 실제 행동을 시작했음을 표시하며, 턴 완료 전에는 이동을 잠급니다.
  markMutation() {
    if (this.isReviewing) this.pendingBranch = true;
    return this.pendingBranch;
  }

  record(snapshot, label = "턴 완료") {
    if (!this.currentNode) return this.initialize(snapshot, label);
    const mustBranch = this.pendingBranch || this.isReviewing || this.currentNode.children.length > 0;
    let branchId = this.currentNode.branchId;
    let branchKind = this.currentNode.branchKind;
    let branchLabel = this.currentNode.branchLabel;
    if (mustBranch) {
      const branchNumber = this.nextBranchNumber++;
      branchId = `branch-${branchNumber}`;
      branchKind = "branch";
      branchLabel = `새 기록 ${branchNumber}`;
    }
    const node = this.createNode({
      snapshot,
      label,
      parentId: this.currentId,
      branchId,
      branchKind,
      branchLabel,
    });
    this.currentId = node.id;
    this.liveNodeId = node.id;
    this.pendingBranch = false;
    return node;
  }

  movePrevious() {
    if (!this.canGoPrevious) return null;
    this.currentId = this.currentNode.parentId;
    return cloneHistoryData(this.currentNode.snapshot);
  }

  moveNext(childId = null) {
    if (!this.canGoNext) return null;
    const children = this.currentNode.children.map((id) => this.nodes.get(id));
    // 선택이 없으면 원래 진행을 우선해 이전 기록을 언제든 다시 따라갈 수 있게 합니다.
    const target = children.find((node) => node.id === childId)
      ?? children.find((node) => node.branchKind === "original")
      ?? children[0];
    this.currentId = target.id;
    return cloneHistoryData(target.snapshot);
  }

  getNextChoices() {
    if (!this.currentNode) return [];
    return this.currentNode.children.map((id) => {
      const node = this.nodes.get(id);
      return { id: node.id, label: `${node.branchLabel} · ${node.label}`, branchKind: node.branchKind };
    });
  }

  getStatus() {
    const node = this.currentNode;
    if (!node) return null;
    const maximumDepth = Math.max(...[...this.nodes.values()].map((item) => item.depth));
    return {
      nodeId: node.id,
      position: node.depth + 1,
      total: maximumDepth + 1,
      label: node.label,
      branchId: node.branchId,
      branchKind: node.branchKind,
      branchLabel: node.branchLabel,
      isReviewing: this.isReviewing,
      pendingBranch: this.pendingBranch,
      hasBranches: node.children.length > 1,
    };
  }
}
