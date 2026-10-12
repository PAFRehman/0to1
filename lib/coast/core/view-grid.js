import * as THREE from 'three';

/** Conservatively discard only water-grid triangles outside the fixed story camera. */
export function createGridViewFilter(mesh, camera) {
  const frustum = new THREE.Frustum(), projection = new THREE.Matrix4(), point = new THREE.Vector3(), box = new THREE.Box3();
  let geometry, fullIndex, key = '';
  return function update() {
    if (geometry !== mesh.geometry) { geometry = mesh.geometry; fullIndex = geometry.index.array; key = ''; }
    const next = camera.projectionMatrix.elements.join(',') + ':' + mesh.matrixWorld.elements.join(',');
    if (next === key) return; key = next;
    projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(projection);
    const positions = geometry.attributes.position, world = new Float32Array(positions.count * 3);
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      const dx = point.x - camera.position.x, dz = point.z - camera.position.z;
      point.y -= (dx * dx + dz * dz) / (2 * 6371000); point.toArray(world, i * 3);
    }
    const visible = [];
    for (let i = 0; i < fullIndex.length; i += 3) {
      box.makeEmpty();
      for (let j = 0; j < 3; j++) box.expandByPoint(point.fromArray(world, fullIndex[i + j] * 3));
      // A generous 16 m guard includes all displaced crests, choppiness and interpolated curvature.
      box.expandByScalar(16);
      if (frustum.intersectsBox(box)) visible.push(fullIndex[i], fullIndex[i + 1], fullIndex[i + 2]);
    }
    geometry.dispose(); geometry.setIndex(visible);
  };
}
