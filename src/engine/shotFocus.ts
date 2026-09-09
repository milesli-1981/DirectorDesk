/**
 * 当前生效镜头的对焦信息。
 *
 * CameraRig 每帧求解机位后写入，景深后处理（DepthOfField）每帧读取——
 * 这样对焦距离只算一次，不必为了后处理再求解一遍机位。
 * 用可变对象而非 store，是因为它每帧都变、且不需要触发任何 React 重渲染。
 */
export const liveShot = {
  /** 对焦点世界坐标（= 镜头 target；过肩时是远处的主体）。直接喂给 DOF 的自动对焦。 */
  focusPoint: [0, 1.55, 0] as [number, number, number],
  /** 相机到对焦点的距离（米），用来按真实光学推导景深范围。 */
  focusDistance: 6,
  /** 当前焦距（mm），用于推导景深范围与虚化强度。 */
  lensMm: 35,
};

/** 假定光圈（f 值）。系统暂无光圈参数，取电影拍摄常用的 f/2.8。 */
const APERTURE_F = 2.8;
/** 全画幅容许弥散圆（mm），行业常用 0.03mm。 */
const CIRCLE_OF_CONFUSION_MM = 0.03;

/**
 * 清晰范围（米）：对焦点前后完全清晰的距离区间。
 *
 * 按真实光学近似 DOF ≈ 2·N·c·d²/f²（N=光圈、c=弥散圆、d=对焦距离、f=焦距），
 * 因此：
 * - 长焦 / 近距离 → 景深极浅（过肩时前景肩膀会自然虚化）；
 * - 广角 → 几乎全景清晰（符合广角镜头实际表现）。
 */
export function focusRangeForLens(lensMm: number, distanceM: number): number {
  const rangeM =
    (2000 * APERTURE_F * CIRCLE_OF_CONFUSION_MM * distanceM * distanceM) / (lensMm * lensMm);
  // 上限不能太小：高空 / 大俯角（无人机）机位到主体距离大、场景纵深也大，
  // 按光学公式本应得到很深的清晰范围（如 24mm@20m ≈ 110m），若强行压到 30m 会让
  // 近地与远景同时落在清晰带外，整画面发虚（"虚焦"）。抬高上限恢复远景深。
  // 近景 / 长焦仍由公式自然给出极浅景深，不受此上限影响。
  return Math.min(200, Math.max(0.15, rangeM));
}

/** 虚化强度：焦距越长光斑越大。 */
export function bokehScaleForLens(lensMm: number): number {
  return Math.min(8, Math.max(1.5, 3 * (lensMm / 50)));
}
