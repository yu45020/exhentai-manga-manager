import { shallowRef, ref, watch, markRaw } from 'vue'
import {
  echoRecord,
  makeSingleTranslator,
  makeLayeredResolver,
  CATEGORY_ORDER
} from '../main/translation/translationResolver.js'

// ---- status ----

let _inited = false
const dictRef = shallowRef(null)   // SINGLE ref: holds the parsed {category:{name:translation}...}
const readyRef = ref(false)
const loadingRef = ref(false)         // renderer requests on demand
const errorRef = ref(null)


// ---------- helpers ----------

const translatorsByCat = Object.fromEntries(
    CATEGORY_ORDER.map(k => [k, ref(echoRecord)])
)

const translator = ref((key, category) => echoRecord(key))


function translate(x, category, { type = 'name' } = {}) {
  // type: 'name' | 'intro'
  const out = translator.value(x, category)
  if (out && typeof out === 'object' && type in out) return out[type]
  else if (typeof out === 'string') return out
  else return name
}


function ensureTranslators() {
  if (!readyRef.value) {
    for (const cat of CATEGORY_ORDER) {
      translatorsByCat[cat].value = makeSingleTranslator(dictRef.value[cat] || Object.create(null))
    }
    // layered resolver across categories
    translator.value = makeLayeredResolver(dictRef.value)
    readyRef.value = true
  }
}

function clearTranslators() {
  if (readyRef.value) {
    for (const cat of CATEGORY_ORDER) translatorsByCat[cat].value = echoRecord
    translator.value = (k) => echoRecord(k)
    readyRef.value = false
  }

}

export function setTranslationPayload(payload) {
  // payload.dict is expected to be the *real* JSON: { data: [...] }
  if (!payload) {
    errorRef.value = 'Invalid translation payload: expected { data: [...] } '
    return
  }
  if (_inited) return

  dictRef.value = markRaw(payload)
  errorRef.value = null

  ensureTranslators()
  _inited = true

}

// Pull once on demand; main returns { ok, dict (the real JSON), ts }
async function ensureTranslationLoaded() {
  if (readyRef.value || loadingRef.value) return
  loadingRef.value = true
  errorRef.value = null
  try {
    const res = await ipcRenderer.invoke('translation:get')
    if (!res?.ok) throw new Error(res?.error || 'translation:get failed')
    setTranslationPayload(res.data) // expects res.data
  } catch (e) {
    console.error('Failed to load translation dict', e)
    errorRef.value = e?.message || String(e)
  } finally {
    loadingRef.value = false
  }
}

export function useTranslationDict() {
  function getSingleTranslator(cat) {
    if (!readyRef.value) throw new Error('Translation dict not ready')
    return translatorsByCat[cat].value
  }

  return {
    // the raw JSON (non-deep reactive)
    translationDict: dictRef,     // {category:{name:translation}...}

    // status
    dictReady: readyRef,
    dictLoading: loadingRef,
    dictError: errorRef,

    // Layered single-key translator: translateTag.value(key, category?) => {name, intro}
    translator,
    translatorsByCat,
    getSingleTranslator,
    ensureTranslationLoaded,
    clearTranslators,
    ensureTranslators,
    translate,
  }
}
