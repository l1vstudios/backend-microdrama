import type { CavemanConfig } from './drado-caveman';
import { dirname, join } from 'node:path';
import type { Lighting } from './drado-lighting';

export function lightingSkillDefinitions(lighting?: Lighting) {
  if (!lighting || lighting === 'auto' || lighting === 'fantasy' || lighting === 'anime') return [];
  const root = join(Bun.env.HOME || '', '.hermes', 'skills');
  return [
    { name: 'cinematic-lighting-techniques', title: 'Cinematic Lighting Techniques', description: 'Lighting sinematik sesuai preset proyek, physical blend, bayangan dan respons material.', path: join(root, 'lighting/cinematic-lighting-techniques/SKILL.md'), enabled: true },
    ...(lighting === 'drama' ? [{ name: 'natural_window_light', title: 'Natural Window Light', description: 'Cahaya jendela untuk adegan interior yang sesuai; tetap mengikuti waktu dan sumber lokasi.', path: join(root, 'lighting/natural_window_light/SKILL.md'), enabled: true }] : []),
  ];
}

export type HermesSkill = { name: string; title: string; description: string; status: 'active' | 'disabled' | 'missing'; version?: string };
type DradoCapability = { id: string; title: string; description: string; source: 'core' | 'reference' };

/** Inventory of exactly the skills this bridge can preload into Hermes. */
export async function listHermesSkills(skillPath: string, caveman?: CavemanConfig, lighting?: Lighting): Promise<HermesSkill[]> {
  const definitions = [
    { name: 'drado-agent', title: 'Drado Agent', description: 'Ide, casting, master asset, serta prompt Nano Banana Pro dan Omni Flash. Menjaga continuity, eyeline, karakter, dan voice lock.', path: skillPath, enabled: true },
    { name: 'caveman', title: 'Caveman', description: 'Meringkas jawaban dan mengurangi pengulangan, dengan prompt produksi tetap lengkap.', path: caveman?.skillPath, enabled: Boolean(caveman?.enabled) },
    ...lightingSkillDefinitions(lighting),
  ];
  return Promise.all(definitions.map(async ({ path, enabled, ...definition }): Promise<HermesSkill> => {
    let available = false; let version: string | undefined;
    if (path) {
      try {
        const file = Bun.file(path);
        available = await file.exists();
        if (available) {
          const header = await file.slice(0, 4000).text();
          version = header.match(/^version:\s*["']?v?(\d+(?:\.\d+){1,3})/mi)?.[1] || header.match(/\bv(\d+\.\d+(?:\.\d+){0,2})\b/i)?.[1];
        }
      } catch { available = false; }
    }
    return { ...definition, version, status: !enabled ? 'disabled' : available ? 'active' : 'missing' };
  }));
}

/** Describe documented abilities without adding these references or optional skills to preloads. */
export async function describeDrado(skillPath: string) {
  let content = '';
  try { content = await Bun.file(skillPath).text(); } catch { /* Missing skill is also reported by the inventory. */ }
  const definitions = [
    { id: 'casting', title: 'Ide cerita & casting', description: 'Mengembangkan premis microdrama, konflik, dan pilihan karakter Auto, Custom, atau Campuran.', match: /CAST DESIGN MODE/i },
    { id: 'masters', title: 'Master karakter, lokasi & properti', description: 'Character sheet, face anchor, outfit anchor, lokasi, dan benda dengan identitas serta nama aset yang konsisten.', match: /CHARACTER MASTER MODE/i },
    { id: 'image', title: 'Prompt image Nano Banana Pro', description: 'Menyusun opening keyframe dengan komposisi, blocking, identitas, wardrobe, serta detail lingkungan.', match: /NANO BANANA PRO.*IMAGE KEYFRAME/i },
    { id: 'video', title: 'Prompt video Omni Flash', description: 'Mengarahkan animasi keyframe, urutan aksi, durasi shot, dialog, dan reaksi antarkarakter.', match: /OMNI FLASH.*VIDEO PROMPT/i },
    { id: 'lighting', title: 'Lighting sinematik & cahaya wajah', description: 'Sumber cahaya termotivasi, arah key light, bounce, kelembutan bayangan, exposure, white balance, serta respons kulit dan material.', match: /NATURAL FACIAL LIGHTING/i },
    { id: 'camera', title: 'Kamera, lensa & depth of field', description: 'Wide, close-up, over-the-shoulder, reverse shot, insert, gerak kamera, dan blur optik sesuai fungsi dramatis.', match: /Camera language library/i },
    { id: 'eyeline', title: 'Blocking & eyeline', description: 'Posisi karakter dalam ruang, arah tubuh dan kepala, target tatapan, serta hubungan pembicara dengan lawan bicara.', match: /DIALOGUE STAGING GEOMETRY/i },
    { id: 'acting', title: 'Akting & ekspresi natural', description: 'Mengatur stimulus, perubahan emosi, mikroekspresi, gerak mata, napas, gestur, dan respons pendengar.', match: /ACTING & EMOTIONAL REACTION CONTINUITY/i },
    { id: 'voice', title: 'Dialog, lip-sync & voice lock', description: 'Tag emosi per ucapan, pemilik dialog yang jelas, profil suara konsisten, dan penguncian mulut karakter yang berbicara.', match: /VOICE_PROFILE.*dialog continuity/i },
    { id: 'continuity', title: 'Continuity visual & objek', description: 'Menjaga wajah, warna kulit, outfit, material, properti, tangan pemegang, posisi, serta start/end state antarshot.', match: /CANONICAL SKIN, COLOR, MATERIAL & VOICE LOCK/i },
    { id: 'qa', title: 'QA & perbaikan prompt', description: 'Memeriksa aturan produksi serta memperbaiki masalah tatapan, objek, warna, dan akting berdasarkan bukti visual yang tersedia.', match: /QA GATE/i },
    { id: 'flow', title: 'Aset Google Flow & prompt siap salin', description: 'Nama aset stabil, aturan @-mention, mode body-only, dan blok prompt yang siap disalin ke Flow.', match: /MODES FOR GOOGLE FLOW COPY\/PASTE/i },
  ];
  const capabilities: DradoCapability[] = definitions.filter(definition => definition.match.test(content))
    .map(({ match, ...definition }) => ({ ...definition, source: 'core' as const }));
  const referenceName = 'references/storyboard-t2v-workflow.md';
  let storyboardAvailable = false;
  try { storyboardAvailable = content.includes(referenceName) && await Bun.file(join(dirname(skillPath), referenceName)).exists(); } catch { /* Optional reference. */ }
  if (storyboardAvailable) capabilities.push({ id: 'storyboard', title: 'Storyboard, T2V & multi-episode', description: 'Perencanaan episode, wardrobe intake, storyboard multi-panel, prompt T2V, serta continuity antar-panel dan antar-clip.', source: 'reference' });
  const references = [{ name: referenceName, title: 'Storyboard + T2V Workflow', description: 'Panduan tambahan untuk storyboard, text-to-video dari referensi, dan cerita multi-episode.', available: storyboardAvailable }];
  const optional = [
    { name: 'cinematic-lighting-techniques', title: 'Cinematic Lighting Techniques', description: 'Panduan tambahan untuk susunan pencahayaan sinematik dan strategi warna.', path: 'lighting/cinematic-lighting-techniques/SKILL.md' },
    { name: 'natural_window_light', title: 'Natural Window Light', description: 'Panduan tambahan untuk pencahayaan alami dari jendela.', path: 'lighting/natural_window_light/SKILL.md' },
    { name: 'rack_focus_technique', title: 'Rack Focus Technique', description: 'Panduan tambahan untuk perpindahan fokus antar subjek.', path: 'cinematography/rack_focus_technique/SKILL.md' },
  ];
  const supportingSkills = await Promise.all(optional.map(async ({ path, ...skill }) => {
    let available = false;
    try { available = await Bun.file(join(Bun.env.HOME || '', '.hermes', 'skills', path)).exists(); } catch { /* Optional skill. */ }
    return { ...skill, available };
  }));
  return { capabilities, references, supportingSkills };
}
