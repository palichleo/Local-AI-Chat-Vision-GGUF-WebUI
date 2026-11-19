/**
 * (0.6.117) The versions of a model: the files on this computer that are one of it, the one that is
 * used, and the workflow as it is made with that one (the page « Modèles », maquette du 19/11).
 *
 * A version is a file of the model, told by what it holds (lib/model-files.mjs): the one Moodix
 * ships the workflow with (« provided »), those found in the folder of the models, those the user
 * added from elsewhere. Nothing is copied nor moved: a file is read where it is.
 *
 * The rule: Moodix uses the provided version. A version the user picks is kept (`statePath`) and
 * used from then on; when its file is gone, the provided one is used again. The choice is kept
 * beside the workflows, never written into one: a shipped workflow stays the shipped one, and an
 * update of it brings no second copy. A workflow the user edited (« Réglages ») is left as they
 * wrote it, its file included: the editor has the last word.
 *
 * Some models come in two ways of being computed (MiniMax H3: distilled in 8 steps, MiniMax's own
 * in 20). The family says how a file tells which (`recipes`, as the engine reads it in
 * runner/pipelines/minimax_h3.py) and what each sets in the workflow; nobody has to know it. A
 * recipe may come in two files (FL2VA, and Ref2VA for the reference images): the second is its
 * `companion`, part of the version and no version of its own.
 */
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { problem } from './engine.mjs';
import { families } from './families.mjs';
import { describeModelFile, fits, modelsOf, taking, versionComponent } from './model-files.mjs';
import { validateNativeWorkflow } from './native-workflows.mjs';
import { atomicFile } from './update-files.mjs';

const EXTENSIONS = new Set(['.safetensors', '.gguf']);
// The same file under two spellings of its path (Windows does not tell the case of letters apart).
const spelled = path => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
const same = (a, b) => spelled(a) === spelled(b);

// What a file name says of its format or of its making, not of what the version is.
const NOT_A_NAME =
  /^(?:int8|fp8|fp16|fp32|bf16|w4a8|nvfp4|convrot|e4m3fn|e5m2|scaled|pruned|comfy|transformer|model|diffusion|safetensors|gguf|\d+b|\d+[-_]?steps?|q\d(?:[_-][0km])*)$/i;

/**
 * The short name of a version, without the name of its model (« Distillé », « Uncensored v1.1 »):
 * the one its family gives the files it knows (`model.names`, by what their name holds), else
 * the name of the file less its model, its format and how it was made; the whole name when
 * nothing is left.
 */
export function versionName(file, manifest) {
  // (Less the mark a GGUF ends with: « .Q8_0 », « -Q4_K_M ».)
  const stem = basename(file)
    .replace(/\.(?:safetensors|gguf)$/i, '')
    .replace(/[._-]q\d+(?:_[a-z0-9]+)*$/i, '');
  for (const known of manifest?.model?.names ?? [])
    if (new RegExp(known.match, 'i').test(stem)) return known.name;
  const own = new Set(
    [manifest?.family ?? '', ...(manifest?.model?.name ?? '').split(/[\s-]+/)]
      .map(word => word.toLowerCase())
      .filter(Boolean),
  );
  const name = stem
    .split(/[\s_-]+/)
    .filter(word => word && !own.has(word.toLowerCase()) && !NOT_A_NAME.test(word))
    .join(' ');
  return name ? name[0].toUpperCase() + name.slice(1) : stem;
}

/** The recipe a file is computed with: the first of the family's whose marks it has, else the one without marks. */
export function recipeOf(spec, described) {
  const recipes = Array.isArray(spec?.recipes) ? spec.recipes : [];
  return recipes.find(recipe => !recipe.fingerprint || fits(described?.shapes, recipe.fingerprint)) ?? null;
}

/**
 * Whether a file is the second file of its recipe (Ref2VA beside FL2VA), by the title it gives
 * itself or by its name: nothing else tells the two apart, their tensors have the same names and
 * shapes (19/11).
 */
export function isCompanion(recipe, described, path) {
  const named = recipe?.companion?.named;
  if (typeof named !== 'string' || !named) return false;
  const pattern = new RegExp(named, 'i');
  return pattern.test(described?.metadata?.['modelspec.title'] ?? '') || pattern.test(basename(path));
}

/**
 * A workflow as it is made with a version of its model. `choice`: { role, asset, file } the file of
 * the version; `parameters`, what its recipe sets (a fixed setting takes the value, one left to the
 * assistant takes it as its default, and each profile that names it); `companions`, the roles a
 * recipe of the family may fill, emptied first; `companion`, { role, asset, file } the one this
 * version fills.
 */
export function withVersion(workflow, { role, asset, file, parameters = {}, companions = [], companion = null }) {
  const next = structuredClone(workflow);
  next.components = { ...next.components, [role]: { policy: 'fixed', asset, file } };
  for (const other of companions) delete next.components[other];
  if (companion) next.components[companion.role] = { policy: 'fixed', asset: companion.asset, file: companion.file };
  for (const [key, value] of Object.entries(parameters)) {
    const policy = next.parameters?.[key];
    if (policy) next.parameters[key] = policy.policy === 'fixed' ? { ...policy, value } : { ...policy, default: value };
    for (const profile of Object.values(next.profiles ?? {}))
      if (profile?.parameters && Object.hasOwn(profile.parameters, key)) profile.parameters[key] = value;
  }
  return validateNativeWorkflow(next);
}

export class ModelVersions {
  /**
   * `statePath`: where the choices are kept (data/model-versions.json). `assets`: the registry of
   * the files (lib/generation-assets.mjs): its folders are those looked in, and a version used is
   * registered there as any file of a workflow. `describe`: what reads a file (tests pass their own).
   */
  constructor({ statePath, assets, describe = describeModelFile }) {
    Object.assign(this, { statePath: resolve(statePath), assets, describe });
    // What a file is for a family, kept while the file stays the same (path, size, date).
    this.facts = new Map();
    // The choices as last read, with the state of their file.
    this.kept = null;
    this.pending = Promise.resolve();
  }

  /** { used: { family: { path, asset, parameters?, companion? } }, added: { family: [path] } }. */
  async #state() {
    let version;
    try {
      const about = await stat(this.statePath);
      version = [about.size, about.mtimeMs].join(':');
      if (this.kept?.version === version) return structuredClone(this.kept.state);
      const stored = JSON.parse(await readFile(this.statePath, 'utf8'));
      const plain = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      const state = { used: {}, added: {} };
      for (const [family, chosen] of Object.entries(plain(stored.used)))
        if (typeof chosen?.path === 'string' && typeof chosen.asset === 'string') state.used[family] = chosen;
      for (const [family, paths] of Object.entries(plain(stored.added)))
        if (Array.isArray(paths)) state.added[family] = paths.filter(path => typeof path === 'string' && path);
      this.kept = { version, state };
      return structuredClone(state);
    } catch {
      // No file yet, or one that cannot be read: nothing chosen, the provided versions.
      return { used: {}, added: {} };
    }
  }
  #save(state) {
    const operation = this.pending.then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true });
      await atomicFile(this.statePath, JSON.stringify({ schemaVersion: 1, ...state }, null, 2));
      this.kept = null;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  /** The family of a workflow and the component its versions are files of, or null. */
  #model(workflow) {
    const manifest = families()[workflow?.pipeline],
      component = versionComponent(manifest);
    return component ? { manifest, ...component } : null;
  }

  /**
   * What the file at `path` is for a family: null when it is not there or is no version of it;
   * else { format, how, reason?, recipe?, parameters?, companion (whether it is the second file
   * of its recipe), bytes }.
   */
  async #fact(path, { manifest, spec }) {
    let about;
    try {
      about = await stat(path);
    } catch {
      return null;
    }
    if (!about.isFile()) return null;
    const key = [spelled(path), about.size, about.mtimeMs, manifest.family].join('|');
    if (!this.facts.has(key)) {
      if (this.facts.size >= 2000) this.facts.clear();
      let fact = null;
      try {
        const described = await this.describe(path, { shapes: true });
        if (modelsOf(described, { [manifest.family]: manifest }).length) {
          const recipe = recipeOf(spec, described),
            taken = taking(spec, described);
          fact = {
            format: described.format,
            how: taken.how,
            ...(taken.reason ? { reason: taken.reason } : {}),
            ...(recipe ? { recipe: recipe.id, parameters: { ...recipe.parameters } } : {}),
            companion: isCompanion(recipe, described, path),
            bytes: about.size,
          };
        }
      } catch {
        // Not a file of a model, or one that cannot be read: no version.
      }
      this.facts.set(key, fact);
    }
    return this.facts.get(key);
  }

  /** The files to look at for a family: those of its folders (one level down too), then those added. */
  async #files(model, state) {
    const { manifest, role } = model,
      folders = [this.assets.folder(manifest.family, role)]
        .flat()
        .filter(folder => typeof folder === 'string' && folder),
      found = [];
    for (const folder of folders) {
      const places = [folder];
      try {
        for (const entry of await readdir(folder, { withFileTypes: true }))
          if (entry.isDirectory()) places.push(join(folder, entry.name));
          else if (EXTENSIONS.has(extname(entry.name).toLowerCase())) found.push(join(folder, entry.name));
      } catch {
        continue;
      }
      for (const place of places.slice(1))
        try {
          for (const entry of await readdir(place, { withFileTypes: true }))
            if (!entry.isDirectory() && EXTENSIONS.has(extname(entry.name).toLowerCase()))
              found.push(join(place, entry.name));
        } catch {
          // Unreadable: nothing to offer from there.
        }
    }
    const here = found.filter((path, index) => found.findIndex(other => same(other, path)) === index),
      added = (state.added[manifest.family] ?? []).filter(path => !here.some(other => same(other, path)));
    return [...here.map(path => ({ path, source: 'found' })), ...added.map(path => ({ path, source: 'added' }))];
  }

  /**
   * The versions of the model of `shipped`, a workflow as Moodix ships it; null for a model whose
   * file is not one to choose. `effective`: that workflow as the catalog lists it (made with the
   * version kept, or edited by the user); the version it really reads is the one said used.
   *
   * { family, role, provided: the name of the file Moodix ships it with, used: the path read (null
   *   when no file is there), versions: [{ path, file, name, bytes, format, how, reason?, recipe?,
   *   parameters?, source: 'provided' | 'found' | 'added', used, companion?: { role, path, file } }] }
   * The version used first, then the provided one, then the others by name.
   */
  async list(shipped, { effective = null } = {}) {
    const model = this.#model(shipped);
    if (!model) return null;
    const { manifest, role, spec } = model,
      state = await this.#state(),
      provided = shipped.components?.[role]?.file ?? '',
      versions = [],
      companions = new Map();
    for (const { path, source } of await this.#files(model, state)) {
      const fact = await this.#fact(path, model);
      if (!fact) continue;
      const { companion, ...told } = fact;
      // The second file of a recipe is part of the version whose first file is there.
      if (companion) companions.set(told.recipe, path);
      else
        versions.push({
          path,
          file: basename(path),
          name: versionName(path, manifest),
          ...told,
          source: basename(path).toLowerCase() === provided.toLowerCase() ? 'provided' : source,
        });
    }
    for (const version of versions) {
      const second = spec.recipes?.find(recipe => recipe.id === version.recipe)?.companion,
        path = second && companions.get(version.recipe);
      if (path) version.companion = { role: second.role, path, file: basename(path) };
    }
    // The file the workflow reads, wherever it was chosen.
    const made = effective ?? (await this.applied(shipped)),
      component = made.components?.[role];
    let used = null;
    if (component?.asset)
      try {
        const read = { kind: role, family: manifest.family, file: component.file };
        used = (await this.assets.resolve(component.asset, read)).path;
      } catch {
        // Nothing there to read: the model is to be downloaded.
      }
    const rank = version => (version.used ? 0 : version.source === 'provided' ? 1 : 2);
    for (const version of versions) version.used = Boolean(used) && same(version.path, used);
    versions.sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file, 'fr', { sensitivity: 'base' }));
    return { family: manifest.family, role, provided, used, versions };
  }

  /**
   * Keeps the version at `path` as the one used for the model of `shipped`; the provided one is
   * the rule, kept by forgetting any other. Refused, in the user's words, for a file that is not
   * a version of it, or that the model does not read as it is.
   */
  async use(shipped, path) {
    const { listed, version } = await this.#pick(shipped, path),
      state = await this.#state();
    if (version.source === 'provided') delete state.used[listed.family];
    else {
      const register = (kind, file) => this.assets.register({ path: file, kind, family: listed.family }),
        second = version.companion ? await register(version.companion.role, version.companion.path) : null;
      state.used[listed.family] = {
        path: version.path,
        asset: (await register(listed.role, version.path)).id,
        ...(version.parameters ? { parameters: version.parameters } : {}),
        ...(second
          ? { companion: { role: version.companion.role, asset: second.id, path: version.companion.path } }
          : {}),
      };
    }
    await this.#save(state);
    return this.list(shipped);
  }
  /** The version at `path` among those of `shipped`, when it can be used: refused in the user's words. */
  async #pick(shipped, path) {
    const listed = await this.list(shipped);
    if (!listed) throw problem(`${shipped?.name ?? 'Ce modèle'} n’a pas de version à choisir.`);
    const version = listed.versions.find(item => same(item.path, path));
    if (!version) throw problem('Cette version n’est plus sur cet ordinateur.', 404);
    if (version.how === 'convert')
      throw problem(`${version.file} est un GGUF : il se convertit avant de servir.`, 409);
    if (version.how !== 'direct')
      throw problem(`${version.file} ne se lit pas avec ${shipped.name} (${version.reason}).`);
    return { listed, version };
  }
  /**
   * The version at `path` as what a workflow is made with (withVersion), its files registered:
   * for a workflow the user edited, which is the one written to. Nothing is kept here.
   */
  async made(shipped, path) {
    const { listed, version } = await this.#pick(shipped, path),
      register = (kind, file) => this.assets.register({ path: file, kind, family: listed.family }),
      second = version.companion ? await register(version.companion.role, version.companion.path) : null;
    return {
      role: listed.role,
      asset: (await register(listed.role, version.path)).id,
      file: version.file,
      parameters: version.parameters ?? {},
      companions: (this.#model(shipped).spec.recipes ?? [])
        .map(recipe => recipe.companion?.role)
        .filter(Boolean),
      companion: second
        ? { role: version.companion.role, asset: second.id, file: version.companion.file }
        : null,
    };
  }

  /**
   * Adds a file from anywhere on the computer to the versions of the model of `shipped`; it is
   * read where it is. Refused with a line that names it when the model does not read it.
   */
  async add(shipped, path) {
    const model = this.#model(shipped);
    if (!model) throw problem(`${shipped?.name ?? 'Ce modèle'} n’a pas de version à choisir.`);
    const fact = await this.#fact(path, model);
    if (!fact) throw problem(`${basename(path)} ne se lit pas avec ${shipped.name}.`);
    if (fact.how === 'refused') throw problem(`${basename(path)} ne se lit pas avec ${shipped.name} (${fact.reason}).`);
    const state = await this.#state(),
      family = model.manifest.family;
    state.added[family] = [...(state.added[family] ?? []).filter(other => !same(other, path)), resolve(path)];
    await this.#save(state);
    return this.list(shipped);
  }

  /** Takes a file the user added out of the versions; the file stays on the disk. Used, the provided one is again. */
  async remove(shipped, path) {
    const model = this.#model(shipped);
    if (!model) return null;
    const state = await this.#state(),
      family = model.manifest.family;
    state.added[family] = (state.added[family] ?? []).filter(other => !same(other, path));
    if (!state.added[family].length) delete state.added[family];
    if (state.used[family] && same(state.used[family].path, path)) delete state.used[family];
    await this.#save(state);
    return this.list(shipped);
  }

  /**
   * `shipped` as it is made with the version the user keeps for its model: the same object when
   * none is kept, when its file is gone, or when the workflow cannot be made with it.
   */
  async applied(shipped) {
    const model = this.#model(shipped);
    if (!model) return shipped;
    const chosen = (await this.#state()).used[model.manifest.family];
    if (!chosen) return shipped;
    const there = async path => {
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    };
    if (!(await there(chosen.path))) return shipped;
    const second = chosen.companion && (await there(chosen.companion.path)) ? chosen.companion : null;
    try {
      return withVersion(shipped, {
        role: model.role,
        asset: chosen.asset,
        file: basename(chosen.path),
        parameters: chosen.parameters,
        companions: (model.spec.recipes ?? []).map(recipe => recipe.companion?.role).filter(Boolean),
        companion: second ? { role: second.role, asset: second.asset, file: basename(second.path) } : null,
      });
    } catch {
      return shipped;
    }
  }
}
