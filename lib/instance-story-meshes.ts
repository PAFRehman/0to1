import * as THREE from 'three'

/** Keep the complete articulated rigs for animation and raycasts, but draw repeated shapes together. */
export function instanceStoryMeshes(root: THREE.Group) {
  const groups = new Map<string, THREE.Mesh[]>()
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !object.userData.penguin || object instanceof THREE.InstancedMesh || Array.isArray(object.material) || object.material.transparent || !object.visible) return
    const key = `${object.geometry.id}:${object.material.id}:${object.castShadow}:${object.receiveShadow}`
    const members = groups.get(key) ?? []; members.push(object); groups.set(key, members)
  })
  const batches: { mesh: THREE.InstancedMesh; members: THREE.Mesh[] }[] = []
  const inverse = new THREE.Matrix4(), local = new THREE.Matrix4()
  for (const members of groups.values()) {
    if (members.length < 2) continue
    const first = members[0]
    const mesh = new THREE.InstancedMesh(first.geometry, first.material, members.length)
    mesh.name = 'batched-story-shapes'; mesh.castShadow = first.castShadow; mesh.receiveShadow = first.receiveShadow
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false
    // Three's raycaster still sees the original rig meshes; only their rendering is suppressed.
    members.forEach(member => { member.visible = false })
    root.add(mesh); batches.push({ mesh, members })
  }
  return {
    count: batches.length,
    update() {
      root.updateMatrixWorld(true); inverse.copy(root.matrixWorld).invert()
      for (const { mesh, members } of batches) {
        let count = 0
        for (const member of members) {
          let visible = true, parent = member.parent
          while (parent && parent !== root) { if (!parent.visible) { visible = false; break } parent = parent.parent }
          if (!visible) continue
          local.multiplyMatrices(inverse, member.matrixWorld); mesh.setMatrixAt(count++, local)
        }
        mesh.count = count; mesh.visible = count > 0; mesh.instanceMatrix.needsUpdate = true
      }
    },
    dispose() { for (const { mesh, members } of batches) { members.forEach(member => { member.visible = true }); mesh.dispose(); mesh.removeFromParent() } batches.length = 0 },
  }
}
