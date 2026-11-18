#!/usr/bin/env npx tsx
/**
 * MDX + BLP → self-contained GLB converter
 * Works with vanilla MPQ extracts AND custom campaign folders side-by-side.
 *
 * Pipeline per model:
 *   1. Parse MDX (war3-model)
 *   2. Resolve BLP paths (same-folder preference → basename → suffix)
 *   3. BLP → PNG, embed in GLB
 *   4. Geosets → mesh primitives (POSITION, NORMAL, TEXCOORD_0, indices)
 *   5. Materials + filter modes (MASK / BLEND)
 *   6. Bones/helpers → node hierarchy + skin (JOINTS_0 / WEIGHTS_0)
 *   7. Sequences → named animation clips (translation / rotation / scale)
 *   8. Validate GLB loads, has meshes / skin / animation channels
 *
 * Usage:
 *   npx tsx mdx_to_glb.ts \
 *     --extracted ./extracted \
 *     --out ./glb \
 *     --samples unit building campaign effect \
 *     --verbose
 *
 *   npx tsx mdx_to_glb.ts \
 *     --extracted ./extracted \
 *     --out ./glb \
 *     --files "War3Patch_xxx/Units/Orc/Grunt/grunt.mdx" \
 *             "War1_Humans/war3campImported/Footman.mdx"
 */
import * as fs from "fs";
import * as path from "path";
import { parseMDX, decodeBLP, getBLPImageData } from "war3-model";
import { PNG } from "pngjs";
import { Document, NodeIO, Primitive } from "@gltf-transform/core";

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════

interface Args {
  extracted: string;
  out: string;
  files: string[];
  samples: string[];
  all: boolean;
  limit: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    extracted: "",
    out: "",
    files: [],
    samples: [],
    all: false,
    limit: 0,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--extracted") args.extracted = argv[++i] || "";
    else if (a === "--out") args.out = argv[++i] || "";
    else if (a === "--files") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) args.files.push(argv[++i]);
    } else if (a === "--samples") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--"))
        args.samples.push(argv[++i].toLowerCase());
    } else if (a === "--all") args.all = true;
    else if (a === "--limit") args.limit = parseInt(argv[++i] || "0", 10) || 0;
    else if (a === "--verbose") args.verbose = true;
  }
  if (!args.extracted || !args.out) {
    console.error(`Usage:
  npx tsx mdx_to_glb.ts --extracted <root> --out <glb_dir>
      [--files rel/path.mdx ...]
      [--samples unit building doodad effect teamcolor campaign]
      [--verbose]

  <root> may contain vanilla MPQ folders (war3_*, War3Patch_*, War3x_*)
  AND custom campaign folders (War1_Humans, War2_Orcs, …) side by side.`);
    process.exit(1);
  }
  return args;
}

// ═══════════════════════════════════════════════════════════════════════════
// Texture index & resolution
// ═══════════════════════════════════════════════════════════════════════════

interface TextureIndex {
  fullRel: Map<string, string>;
  byBase: Map<string, string[]>;
  byTop: Map<string, Map<string, string>>;
}

function buildTextureIndex(root: string): TextureIndex {
  const fullRel = new Map<string, string>();
  const byBase = new Map<string, string[]>();
  const byTop = new Map<string, Map<string, string>>();

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.name.toLowerCase().endsWith(".blp")) continue;

      const rel = path.relative(root, full).split(path.sep).join("/");
      const relLower = rel.toLowerCase();
      const base = e.name.toLowerCase();
      const top = rel.split("/")[0].toLowerCase();

      fullRel.set(relLower, full);

      if (!byBase.has(base)) byBase.set(base, []);
      byBase.get(base)!.push(full);

      if (!byTop.has(top)) byTop.set(top, new Map());
      const tm = byTop.get(top)!;
      tm.set(base, full);
      tm.set(base.replace(/\.blp$/i, ""), full);
    }
  }
  walk(root);
  return { fullRel, byBase, byTop };
}

function isVanillaTop(top: string): boolean {
  const t = top.toLowerCase();
  return (
    t.startsWith("war3") ||
    t.startsWith("war3patch") ||
    t.startsWith("war3x")
  );
}

function rankTexturePath(absPath: string): number {
  const lower = absPath.replace(/\\/g, "/").toLowerCase();
  if (lower.includes("/war3patch")) return 0;
  if (lower.includes("/war3x")) return 1;
  if (lower.includes("/war3_") || lower.includes("/war3/")) return 2;
  if (lower.includes("war3")) return 3;
  return 10;
}

function pickBest(paths: string[]): string {
  return paths.slice().sort((a, b) => rankTexturePath(a) - rankTexturePath(b))[0];
}

function resolveTexture(
  texPath: string | undefined,
  index: TextureIndex,
  mdxRelPath?: string
): string | null {
  if (!texPath || !texPath.trim()) return null;
  const normalized = texPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const lower = normalized.toLowerCase();
  const base = path.basename(lower);
  const baseNoExt = base.replace(/\.blp$/i, "");

  if (index.fullRel.has(lower)) return index.fullRel.get(lower)!;

  if (mdxRelPath) {
    const top = mdxRelPath.split("/")[0].toLowerCase();
    const topMap = index.byTop.get(top);
    if (topMap) {
      if (topMap.has(base)) return topMap.get(base)!;
      if (topMap.has(baseNoExt)) return topMap.get(baseNoExt)!;
      const underTop = `${top}/${lower}`;
      if (index.fullRel.has(underTop)) return index.fullRel.get(underTop)!;
    }
  }

  const vanillaHits: string[] = [];
  const otherHits: string[] = [];
  for (const hit of index.byBase.get(base) || []) {
    if (rankTexturePath(hit) < 10) vanillaHits.push(hit);
    else otherHits.push(hit);
  }
  if (vanillaHits.length) return pickBest(vanillaHits);
  if (otherHits.length) return pickBest(otherHits);

  const noExtHits: string[] = [];
  for (const [k, paths] of index.byBase) {
    if (k.replace(/\.blp$/i, "") === baseNoExt) noExtHits.push(...paths);
  }
  if (noExtHits.length) return pickBest(noExtHits);

  const suffixHits: string[] = [];
  for (const [rel, abs] of index.fullRel) {
    if (rel.endsWith("/" + lower) || rel === lower || rel.endsWith("/" + base)) {
      suffixHits.push(abs);
    }
  }
  if (suffixHits.length) return pickBest(suffixHits);

  for (const [top, topMap] of index.byTop) {
    if (!isVanillaTop(top)) continue;
    if (topMap.has(base)) return topMap.get(base)!;
    if (topMap.has(baseNoExt)) return topMap.get(baseNoExt)!;
  }
  return null;
}

function blpToPngBuffer(blpPath: string): {
  buffer: Buffer;
  width: number;
  height: number;
} {
  const raw = fs.readFileSync(blpPath);
  const blp = decodeBLP(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
  );
  const img = getBLPImageData(blp, 0);
  const png = new PNG({ width: img.width, height: img.height });
  const src = img.data;
  for (let i = 0; i < src.length; i++) png.data[i] = src[i];
  return { buffer: PNG.sync.write(png), width: img.width, height: img.height };
}

/** WC3 Z-up → glTF Y-up: (x,y,z) → (x, z, -y) */
function wc3ToGltfVec3(src: ArrayLike<number>): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    out[i] = x;
    out[i + 1] = z;
    out[i + 2] = -y;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sample picker
// ═══════════════════════════════════════════════════════════════════════════

const SAMPLE_PATTERNS: Record<string, RegExp[]> = {
  unit: [
    /Units\/Orc\/Grunt\/grunt\.mdx$/i,
    /Units\/Undead\/Ghoul\/Ghoul\.mdx$/i,
    /Units\/Human\/Footman\/Footman\.mdx$/i,
    /Units\/NightElf\/Archer\/Archer\.mdx$/i,
    /Units\/Orc\/Peon\/peon\.mdx$/i,
    /war3campImported\/Footman\.mdx$/i,
    /war3campImported\/GruntWC1v2\.mdx$/i,
    /war3campImported\/PeasantWC1v3\.mdx$/i,
    /war3campImported\/KnightWC1\.mdx$/i,
  ],
  building: [
    /Buildings\/Undead\/Necropolis\/Necropolis\.mdx$/i,
    /Buildings\/Orc\/GreatHall\/GreatHall\.mdx$/i,
    /Buildings\/Human\/TownHall\/TownHall\.mdx$/i,
    /Buildings\/Other\/GoblinShipyard\/GoblinShipyard\.mdx$/i,
    /war3campImported\/TownHallWC1_Purist\.mdx$/i,
    /war3campImported\/GreatHallWC1v2_Purist\.mdx$/i,
    /war3campImported\/Blacksmith\.mdx$/i,
    /war3campImported\/ChurchWC1\.mdx$/i,
  ],
  doodad: [
    /Doodads\//i,
    /Objects\/InventoryItems\//i,
    /war3campImported\/Wall\.mdx$/i,
    /war3campImported\/LogBridge/i,
  ],
  effect: [
    /Abilities\/Spells\/Other\/Volcano\/Volcano\.mdx$/i,
    /Abilities\/Spells\/Other\/Transmute\/PileofGold\.mdx$/i,
    /Abilities\/Spells\/Other\/TinkerRocket\/TinkerRocketMissile\.mdx$/i,
    /Abilities\/Weapons\//i,
    /war3campImported\/BoltMissile\.mdx$/i,
    /war3campImported\/ClericMissile\.mdx$/i,
  ],
  teamcolor: [
    /Units\/Orc\/Grunt\/grunt\.mdx$/i,
    /Units\/Human\/Footman\/Footman\.mdx$/i,
    /Units\/NightElf\/Archer\/Archer\.mdx$/i,
    /war3campImported\/Footman\.mdx$/i,
    /war3campImported\/GruntWC1v2\.mdx$/i,
  ],
  campaign: [
    /War1_Humans\/war3campImported\/Footman\.mdx$/i,
    /War1_Orcs\/war3campImported\/GruntWC1v2\.mdx$/i,
    /War1_Humans\/war3campImported\/Lothar\.mdx$/i,
    /War1_Orcs\/war3campImported\/Garona\.mdx$/i,
    /War1_Humans\/war3campImported\/TownHallWC1_Purist\.mdx$/i,
    /War2_Humans\/war3campImported\//i,
  ],
};

function collectAllMdx(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.toLowerCase().endsWith(".mdx")) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }
  walk(root);
  return out.sort();
}

function pickSamples(all: string[], kinds: string[]): string[] {
  const picked: string[] = [];
  const used = new Set<string>();
  for (const kind of kinds) {
    const patterns = SAMPLE_PATTERNS[kind] || [];
    let found = false;
    for (const re of patterns) {
      const match = all.find((p) => re.test(p) && !used.has(p));
      if (match) {
        picked.push(match);
        used.add(match);
        found = true;
        break;
      }
    }
    if (!found) {
      const loose = all.find(
        (p) => p.toLowerCase().includes(kind) && !used.has(p)
      );
      if (loose) {
        picked.push(loose);
        used.add(loose);
      }
    }
  }
  return picked;
}

// ═══════════════════════════════════════════════════════════════════════════
// Conversion
// ═══════════════════════════════════════════════════════════════════════════

interface ConversionResult {
  source: string;
  glbPath: string | null;
  status: "ok" | "error";
  error?: string;
  warnings: string[];
  stats: {
    geosets: number;
    vertices: number;
    triangles: number;
    bones: number;
    sequences: number;
    texturesResolved: number;
    texturesMissing: number;
    hasSkin: boolean;
    animationClips: number;
  };
}

async function convertOne(
  mdxAbsPath: string,
  relPath: string,
  textureIndex: TextureIndex,
  outDir: string,
  verbose: boolean
): Promise<ConversionResult> {
  const warnings: string[] = [];
  const stats = {
    geosets: 0,
    vertices: 0,
    triangles: 0,
    bones: 0,
    sequences: 0,
    texturesResolved: 0,
    texturesMissing: 0,
    hasSkin: false,
    animationClips: 0,
  };

  try {
    const buf = fs.readFileSync(mdxAbsPath);
    const model = parseMDX(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    );

    const doc = new Document();
    const buffer = doc.createBuffer();

    // ── Textures ──────────────────────────────────────────────────────────
    const textureSlots: (ReturnType<Document["createTexture"]> | null)[] = [];
    const textures = model.Textures || [];

    for (let ti = 0; ti < textures.length; ti++) {
      const t = textures[ti];
      const resolved = resolveTexture(t.Image, textureIndex, relPath);

      if (!resolved) {
        if (t.ReplaceableId && t.ReplaceableId > 0) {
          warnings.push(
            `Texture[${ti}] replaceable ID ${t.ReplaceableId} (team color) – no file`
          );
        } else {
          warnings.push(`Texture[${ti}] missing: ${t.Image || "(empty)"}`);
          stats.texturesMissing++;
        }
        textureSlots.push(null);
        continue;
      }

      try {
        const { buffer: pngBuf } = blpToPngBuffer(resolved);
        const tex = doc
          .createTexture(path.basename(resolved, ".blp"))
          .setMimeType("image/png")
          .setImage(new Uint8Array(pngBuf));
        textureSlots.push(tex);
        stats.texturesResolved++;
        if (verbose)
          console.log(`    tex[${ti}] ${t.Image} → ${path.basename(resolved)}`);
      } catch (e: any) {
        warnings.push(`BLP decode failed ${resolved}: ${e.message}`);
        textureSlots.push(null);
        stats.texturesMissing++;
      }
    }

    // ── Materials ────────────────────────────────────────────────────────
    const materials = model.Materials || [];
    const gltfMaterials: ReturnType<Document["createMaterial"]>[] = [];

    for (let mi = 0; mi < materials.length; mi++) {
      const mat = materials[mi];
      const layer = (mat.Layers && mat.Layers[0]) || null;
      const gmat = doc.createMaterial(`mat_${mi}`);
      gmat.setMetallicFactor(0);
      gmat.setRoughnessFactor(1);

      if (layer) {
        const texId =
          typeof layer.TextureID === "number" ? layer.TextureID : 0;
        const tex = textureSlots[texId] ?? null;
        if (tex) gmat.setBaseColorTexture(tex);

        const fm = layer.FilterMode ?? 0;
        if (fm === 1) gmat.setAlphaMode("MASK").setAlphaCutoff(0.75);
        else if (fm >= 2) gmat.setAlphaMode("BLEND");

        if (typeof layer.Alpha === "number") {
          const c = gmat.getBaseColorFactor();
          gmat.setBaseColorFactor([c[0], c[1], c[2], layer.Alpha]);
        }
        if (layer.Shading && layer.Shading & 16) gmat.setDoubleSided(true);
      }
      gltfMaterials.push(gmat);
    }
    if (!gltfMaterials.length) {
      const d = doc.createMaterial("default");
      d.setMetallicFactor(0);
      d.setRoughnessFactor(1);
      gltfMaterials.push(d);
    }

    // ── Skeleton nodes ───────────────────────────────────────────────────
    const bones = model.Bones || [];
    const helpers = model.Helpers || [];
    const allNodes = [...bones, ...helpers];
    stats.bones = bones.length;

    const nodeByObjectId = new Map<
      number,
      ReturnType<Document["createNode"]>
    >();

    for (const n of allNodes) {
      const gnode = doc.createNode(n.Name || `node_${n.ObjectId}`);
      nodeByObjectId.set(n.ObjectId, gnode);
    }

    for (const n of allNodes) {
      const gnode = nodeByObjectId.get(n.ObjectId)!;
      if (n.Parent != null && n.Parent >= 0) {
        const parent = nodeByObjectId.get(n.Parent);
        if (parent) parent.addChild(gnode);
      }
    }

    const rootNodes = allNodes.filter(
      (n) =>
        n.Parent == null ||
        n.Parent < 0 ||
        !nodeByObjectId.has(n.Parent as number)
    );

    // ── Skin ─────────────────────────────────────────────────────────────
    let skin: ReturnType<Document["createSkin"]> | null = null;
    if (bones.length > 0) {
      skin = doc.createSkin("Armature");
      for (const b of bones) {
        const jn = nodeByObjectId.get(b.ObjectId);
        if (jn) skin.addJoint(jn);
      }
      const ibmData = new Float32Array(bones.length * 16);
      for (let i = 0; i < bones.length; i++) {
        ibmData[i * 16 + 0] = 1;
        ibmData[i * 16 + 5] = 1;
        ibmData[i * 16 + 10] = 1;
        ibmData[i * 16 + 15] = 1;
      }
      skin.setInverseBindMatrices(
        doc
          .createAccessor("IBM")
          .setType("MAT4")
          .setArray(ibmData)
          .setBuffer(buffer)
      );
      stats.hasSkin = true;
    }

    // ── Geosets → meshes ─────────────────────────────────────────────────
    const geosets = model.Geosets || [];
    stats.geosets = geosets.length;
    const meshNodes: ReturnType<Document["createNode"]>[] = [];

    const jointIndex = new Map<number, number>();
    bones.forEach((b, i) => jointIndex.set(b.ObjectId, i));

    for (let gi = 0; gi < geosets.length; gi++) {
      const g = geosets[gi];
      const positions = g.Vertices;
      const normals = g.Normals;
      const uvs =
        g.TVertices && g.TVertices.length > 0 ? g.TVertices[0] : null;
      const indices = g.Faces;

      if (!positions || !indices || positions.length < 3) {
        warnings.push(`Geoset ${gi}: empty geometry, skipped`);
        continue;
      }

      const vertCount = positions.length / 3;
      stats.vertices += vertCount;
      stats.triangles += indices.length / 3;

      const prim = doc
        .createPrimitive()
        .setAttribute(
          "POSITION",
          doc
            .createAccessor(`pos_${gi}`)
            .setType("VEC3")
            .setArray(wc3ToGltfVec3(positions))
            .setBuffer(buffer)
        )
        .setIndices(
          doc
            .createAccessor(`idx_${gi}`)
            .setType("SCALAR")
            .setArray(new Uint16Array(indices))
            .setBuffer(buffer)
        );

      if (normals && normals.length === positions.length) {
        prim.setAttribute(
          "NORMAL",
          doc
            .createAccessor(`norm_${gi}`)
            .setType("VEC3")
            .setArray(wc3ToGltfVec3(normals))
            .setBuffer(buffer)
        );
      }

      if (uvs && uvs.length === vertCount * 2) {
        const flipped = new Float32Array(uvs.length);
        for (let i = 0; i < vertCount; i++) {
          flipped[i * 2] = uvs[i * 2];
          flipped[i * 2 + 1] = 1 - uvs[i * 2 + 1];
        }
        prim.setAttribute(
          "TEXCOORD_0",
          doc
            .createAccessor(`uv_${gi}`)
            .setType("VEC2")
            .setArray(flipped)
            .setBuffer(buffer)
        );
      }

      if (skin && g.VertexGroup && g.Groups && g.Groups.length > 0) {
        const joints = new Uint16Array(vertCount * 4);
        const weights = new Float32Array(vertCount * 4);

        for (let v = 0; v < vertCount; v++) {
          const groupIdx = g.VertexGroup[v];
          const boneIds = g.Groups[groupIdx] || [];
          const nInf = Math.min(boneIds.length, 4);
          let wSum = 0;
          for (let k = 0; k < nInf; k++) {
            const jIdx = jointIndex.get(boneIds[k]);
            if (jIdx != null) {
              joints[v * 4 + k] = jIdx;
              weights[v * 4 + k] = 1;
              wSum += 1;
            }
          }
          if (wSum > 0) {
            for (let k = 0; k < 4; k++) weights[v * 4 + k] /= wSum;
          } else {
            weights[v * 4] = 1;
          }
        }

        prim.setAttribute(
          "JOINTS_0",
          doc
            .createAccessor(`joints_${gi}`)
            .setType("VEC4")
            .setArray(joints)
            .setBuffer(buffer)
        );
        prim.setAttribute(
          "WEIGHTS_0",
          doc
            .createAccessor(`weights_${gi}`)
            .setType("VEC4")
            .setArray(weights)
            .setBuffer(buffer)
        );
      }

      const matId = Math.min(g.MaterialID ?? 0, gltfMaterials.length - 1);
      prim.setMaterial(gltfMaterials[matId]);
      prim.setMode(Primitive.Mode.TRIANGLES);

      const mesh = doc.createMesh(`geoset_${gi}`).addPrimitive(prim);
      const meshNode = doc.createNode(`mesh_${gi}`).setMesh(mesh);
      if (skin) meshNode.setSkin(skin);
      meshNodes.push(meshNode);
    }

    // ── Animations ───────────────────────────────────────────────────────
    const sequences = model.Sequences || [];
    stats.sequences = sequences.length;
    const TICKS_PER_SEC = 1000;

    for (const seq of sequences) {
      const [start, end] = seq.Interval || [0, 0];
      if (end <= start) continue;

      const anim = doc.createAnimation(seq.Name || "Anim");
      let channelCount = 0;

      for (const n of allNodes) {
        const gnode = nodeByObjectId.get(n.ObjectId);
        if (!gnode) continue;

        if (n.Translation?.Keys?.length) {
          const keys = n.Translation.Keys.filter(
            (k) => k.Frame >= start && k.Frame <= end
          );
          if (keys.length >= 1) {
            const times = new Float32Array(keys.length);
            const values = new Float32Array(keys.length * 3);
            keys.forEach((k, i) => {
              times[i] = (k.Frame - start) / TICKS_PER_SEC;
              values[i * 3] = k.Vector[0];
              values[i * 3 + 1] = k.Vector[2];
              values[i * 3 + 2] = -k.Vector[1];
            });
            const input = doc
              .createAccessor()
              .setType("SCALAR")
              .setArray(times)
              .setBuffer(buffer);
            const output = doc
              .createAccessor()
              .setType("VEC3")
              .setArray(values)
              .setBuffer(buffer);
            const sampler = doc
              .createAnimationSampler()
              .setInput(input)
              .setOutput(output)
              .setInterpolation("LINEAR");
            anim
              .addSampler(sampler)
              .addChannel(
                doc
                  .createAnimationChannel()
                  .setTargetNode(gnode)
                  .setTargetPath("translation")
                  .setSampler(sampler)
              );
            channelCount++;
          }
        }

        if (n.Rotation?.Keys?.length) {
          const keys = n.Rotation.Keys.filter(
            (k) => k.Frame >= start && k.Frame <= end
          );
          if (keys.length >= 1) {
            const times = new Float32Array(keys.length);
            const values = new Float32Array(keys.length * 4);
            keys.forEach((k, i) => {
              times[i] = (k.Frame - start) / TICKS_PER_SEC;
              values[i * 4] = k.Vector[0];
              values[i * 4 + 1] = k.Vector[2];
              values[i * 4 + 2] = -k.Vector[1];
              values[i * 4 + 3] = k.Vector[3];
            });
            const input = doc
              .createAccessor()
              .setType("SCALAR")
              .setArray(times)
              .setBuffer(buffer);
            const output = doc
              .createAccessor()
              .setType("VEC4")
              .setArray(values)
              .setBuffer(buffer);
            const sampler = doc
              .createAnimationSampler()
              .setInput(input)
              .setOutput(output)
              .setInterpolation("LINEAR");
            anim
              .addSampler(sampler)
              .addChannel(
                doc
                  .createAnimationChannel()
                  .setTargetNode(gnode)
                  .setTargetPath("rotation")
                  .setSampler(sampler)
              );
            channelCount++;
          }
        }

        if (n.Scaling?.Keys?.length) {
          const keys = n.Scaling.Keys.filter(
            (k) => k.Frame >= start && k.Frame <= end
          );
          if (keys.length >= 1) {
            const times = new Float32Array(keys.length);
            const values = new Float32Array(keys.length * 3);
            keys.forEach((k, i) => {
              times[i] = (k.Frame - start) / TICKS_PER_SEC;
              values[i * 3] = k.Vector[0];
              values[i * 3 + 1] = k.Vector[2];
              values[i * 3 + 2] = k.Vector[1];
            });
            const input = doc
              .createAccessor()
              .setType("SCALAR")
              .setArray(times)
              .setBuffer(buffer);
            const output = doc
              .createAccessor()
              .setType("VEC3")
              .setArray(values)
              .setBuffer(buffer);
            const sampler = doc
              .createAnimationSampler()
              .setInput(input)
              .setOutput(output)
              .setInterpolation("LINEAR");
            anim
              .addSampler(sampler)
              .addChannel(
                doc
                  .createAnimationChannel()
                  .setTargetNode(gnode)
                  .setTargetPath("scale")
                  .setSampler(sampler)
              );
            channelCount++;
          }
        }
      }

      if (channelCount > 0) stats.animationClips++;
      else anim.dispose();
    }

    const pe2 = (model.ParticleEmitters2 || []).length;
    const ribbons = (model.RibbonEmitters || []).length;
    const events = (model.EventObjects || []).length;
    if (pe2) warnings.push(`${pe2} ParticleEmitter2 not exported`);
    if (ribbons) warnings.push(`${ribbons} RibbonEmitter not exported`);
    if (events) warnings.push(`${events} EventObject not exported`);

    // ── Scene ────────────────────────────────────────────────────────────
    const scene = doc.createScene(model.Info?.Name || "Scene");
    for (const rn of rootNodes) {
      const gn = nodeByObjectId.get(rn.ObjectId);
      if (gn) scene.addChild(gn);
    }
    for (const mn of meshNodes) scene.addChild(mn);
    doc.getRoot().setDefaultScene(scene);

    // ── Write GLB ────────────────────────────────────────────────────────
    const outRel = relPath.replace(/\.mdx$/i, ".glb");
    const outAbs = path.join(outDir, outRel);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });

    const io = new NodeIO();
    const bytes = await io.writeBinary(doc);
    fs.writeFileSync(outAbs, bytes);

    return {
      source: relPath,
      glbPath: outAbs,
      status: "ok",
      warnings,
      stats,
    };
  } catch (e: any) {
    return {
      source: relPath,
      glbPath: null,
      status: "error",
      error: e.message || String(e),
      warnings,
      stats,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════════════

async function validateGlb(glbPath: string): Promise<string[]> {
  const issues: string[] = [];
  try {
    const io = new NodeIO();
    const doc = await io.read(glbPath);
    const root = doc.getRoot();

    if (!root.listScenes().length) issues.push("No scenes");
    const meshes = root.listMeshes();
    if (!meshes.length) issues.push("No meshes");

    let prims = 0;
    for (const m of meshes) {
      for (const p of m.listPrimitives()) {
        prims++;
        if (!p.getAttribute("POSITION"))
          issues.push(`Mesh "${m.getName()}" missing POSITION`);
      }
    }
    if (!prims) issues.push("No primitives");

    for (const s of root.listSkins()) {
      if (!s.listJoints().length) issues.push("Skin has zero joints");
      if (!s.getInverseBindMatrices())
        issues.push("Skin missing inverse bind matrices");
    }

    for (const a of root.listAnimations()) {
      if (!a.listChannels().length)
        issues.push(`Animation "${a.getName()}" has no channels`);
    }
  } catch (e: any) {
    issues.push(`Failed to load GLB: ${e.message}`);
  }
  return issues;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const args = parseArgs(process.argv);
  const extracted = path.resolve(args.extracted);
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  if (!fs.existsSync(extracted)) {
    console.error(`Extracted root not found: ${extracted}`);
    process.exit(1);
  }

  console.log("Indexing BLP textures…");
  const textureIndex = buildTextureIndex(extracted);
  console.log(
    `  ${textureIndex.fullRel.size} paths, ` +
      `${textureIndex.byBase.size} basenames, ` +
      `${textureIndex.byTop.size} top-level folders`
  );

  const allMdx = collectAllMdx(extracted);
  console.log(`  ${allMdx.length} MDX files available`);

  let targets: string[] = [];
  if (args.all) {
    targets = allMdx;
    if (args.limit > 0) targets = targets.slice(0, args.limit);
    console.log(
      `Batch mode: ${targets.length} of ${allMdx.length} MDX files` +
        (args.limit > 0 ? ` (limit ${args.limit})` : "")
    );
  } else if (args.files.length) {
    targets = args.files;
  } else if (args.samples.length) {
    targets = pickSamples(allMdx, args.samples);
    console.log(`Sample selection (${args.samples.join(", ")}):`);
    targets.forEach((t) => console.log(`  • ${t}`));
  } else {
    targets = pickSamples(allMdx, [
      "unit",
      "building",
      "doodad",
      "effect",
      "teamcolor",
      "campaign",
    ]);
    if (!targets.length) targets = allMdx.slice(0, 5);
    console.log("Default sample set:");
    targets.forEach((t) => console.log(`  • ${t}`));
  }

  if (!targets.length) {
    console.error("No MDX targets found.");
    process.exit(1);
  }

  const results: ConversionResult[] = [];

  for (const rel of targets) {
    const abs = path.join(extracted, rel);
    if (!fs.existsSync(abs)) {
      console.error(`  MISSING ${rel}`);
      results.push({
        source: rel,
        glbPath: null,
        status: "error",
        error: "file not found",
        warnings: [],
        stats: {
          geosets: 0,
          vertices: 0,
          triangles: 0,
          bones: 0,
          sequences: 0,
          texturesResolved: 0,
          texturesMissing: 0,
          hasSkin: false,
          animationClips: 0,
        },
      });
      continue;
    }

    console.log(`\nConverting ${rel} …`);
    const result = await convertOne(
      abs,
      rel,
      textureIndex,
      outDir,
      args.verbose
    );
    results.push(result);

    if (result.status === "ok" && result.glbPath) {
      console.log(
        `  OK → ${path.relative(outDir, result.glbPath)}  ` +
          `(${result.stats.geosets} geosets, ${result.stats.vertices} verts, ` +
          `${result.stats.bones} bones, ${result.stats.animationClips} clips, ` +
          `${result.stats.texturesResolved} textures)`
      );
      for (const w of result.warnings) console.log(`  ⚠ ${w}`);

      const issues = await validateGlb(result.glbPath);
      if (issues.length) {
        console.log("  Validation issues:");
        issues.forEach((i) => console.log(`    • ${i}`));
        result.warnings.push(...issues.map((i) => `validate: ${i}`));
      } else {
        console.log("  Validation: passed");
      }
    } else {
      console.error(`  FAIL: ${result.error}`);
    }
  }

  const reportPath = path.join(outDir, "conversion_report.json");
  const report = {
    created: new Date().toISOString(),
    extracted,
    out: outDir,
    results,
    summary: {
      total: results.length,
      ok: results.filter((r) => r.status === "ok").length,
      failed: results.filter((r) => r.status === "error").length,
    },
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${reportPath}`);
  console.log(
    `Done: ${report.summary.ok} ok, ${report.summary.failed} failed`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});