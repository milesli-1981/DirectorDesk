import * as THREE from "three";

// 复现 CameraProxy 的朝向处理：普通 Object3D.lookAt
const group = new THREE.Group();
group.position.set(-11.75, 3.25, 2.28);
const target = new THREE.Vector3(-6, 1.55, 4);
group.lookAt(target);
group.updateMatrixWorld(true);

const localZ = new THREE.Vector3(0, 0, 1).applyQuaternion(group.quaternion).normalize();
const toTarget = target.clone().sub(group.position).normalize();
console.log("dot(+Z, dir-to-target) =", localZ.dot(toTarget).toFixed(4), "(1 = +Z 指向目标)");

const distance = 4.5;
const halfHeight = Math.tan(((2 * Math.atan(24 / (2 * 50)) * 180) / Math.PI) * Math.PI / 360) * distance;
const halfWidth = halfHeight * 2.39;
const farCenter = new THREE.Vector3(0, 0, distance).applyMatrix4(group.matrixWorld);
const camToFar = farCenter.clone().sub(group.position);
console.log("far-plane center =", farCenter.toArray().map((v) => v.toFixed(2)).join(", "));
console.log(
  "far plane is on target side:",
  camToFar.normalize().dot(toTarget) > 0.99,
  "| halfW/halfH =",
  halfWidth.toFixed(2),
  halfHeight.toFixed(2),
);
