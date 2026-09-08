/**
 * 统一的「锁」角标按钮。
 *
 * 原先工具栏 / 场景树 / 资产面板各写各的文字按钮（Lock View / Locked / Lock position），
 * 既占横向空间、三处风格也不统一。这里统一成只显示锁图标的角标，
 * 语义交给 title 与 aria-pressed 表达，鼠标悬停即可看到说明。
 */
export function LockBadge({
  locked,
  title,
  onClick,
}: {
  locked: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`lock-icon-btn ${locked ? "on" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={locked}
      onClick={onClick}
    >
      <LockGlyph locked={locked} />
    </button>
  );
}

/** 锁形图标：锁定 = 锁梁闭合；未锁定 = 锁梁向右上打开。 */
function LockGlyph({ locked }: { locked: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d={locked ? "M4.8 7V5.2a3.2 3.2 0 0 1 6.4 0V7" : "M4.8 7V5.2a3.2 3.2 0 0 1 5.9-1.6"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <rect x="3" y="7" width="10" height="7" rx="1.7" fill="currentColor" />
    </svg>
  );
}
