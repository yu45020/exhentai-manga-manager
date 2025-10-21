import { markRaw, ref, shallowRef } from 'vue'
import {
  CATEGORY_ORDER,
  echoRecord,
  makeLayeredResolver,
  makeSingleTranslator
} from '../../main/translation/translationResolver.js'


export function translationSlice() {
  // ---- status ----
  let _inited = false
  let dictRef = shallowRef(null)   // SINGLE ref: holds the parsed {category:{name:translation}...}
  let readyRef = ref(false)
  let loadingRef = ref(false)         // renderer requests on demand
  let errorRef = ref(null)

  const translator = ref((key, category) => echoRecord(key))
  const translatorsByCat = Object.fromEntries(
      CATEGORY_ORDER.map(k => [k, ref(echoRecord)])
  )

  // ---------- helpers ----------
  function makeEchoTranslator() {
    return markRaw((name) => (String(name ?? '')))
  }

  function makeTranslator() {
    function resolve(name, category, { type = 'name' } = {}) {
      const out = translator.value(name, category)
      if (out && typeof out === 'object' && type in out) return out[type]
      else if (typeof out === 'string') return out
      else return name
    }

    return markRaw(resolve)
  }

  function translate(x, category, { type = 'name' } = {}) {
    // type: 'name' | 'intro'
    const out = translator.value(x, category)
    if (out && typeof out === 'object' && type in out) return out[type]
    else if (typeof out === 'string') return out
    else return name
  }


  function getSingleTranslator(cat) {
    if (!readyRef.value) throw new Error('Translation dict not ready')
    return translatorsByCat[cat].value
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


  function setTranslationPayload(payload) {

    // payload.dict is expected to be the *real* JSON: { data: [...] }
    if (!payload) {
      errorRef.value = 'Invalid translation payload: expected { data: [...] } '
      return
    }
    if (_inited) return

    dictRef.value = markRaw(payload)
    errorRef.value = null
    readyRef.value = false
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

  return {
    //  ----------------  The following are exposed for testing  ----------------
    // the raw JSON (non-deep reactive)
    // translationDict: dictRef,     // {category:{name:translation}...}

    // status
    // dictReady: readyRef,
    // dictLoading: loadingRef,
    // dictError: errorRef,

    // Layered single-key translator: translateTag.value(key, category?) => {name, intro}
    // translator,
    // translatorsByCat,
    // getSingleTranslator,
    // translate,
    // ensureTranslators,
    // --------------------------------------------------------------------------------
    ensureTranslationLoaded,
    makeEchoTranslator,
    makeTranslator
  }
}
