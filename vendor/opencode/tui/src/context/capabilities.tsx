import { createContext, createSignal, onCleanup, useContext, type JSX } from "solid-js"

export type CapabilityStatus = "supported" | "unavailable" | "partial"

export type CapabilityEntry = Readonly<{
  status: CapabilityStatus
  limitations?: readonly string[]
}>

export type BridgeCapabilities = Readonly<{
  protocol: number
  global: Readonly<Record<string, CapabilityEntry>>
  perModel: Readonly<Record<string, CapabilityEntry>>
}>

type CapabilitiesContextType = Readonly<{
  data: () => BridgeCapabilities | undefined
  error: () => string | undefined
  refresh: () => void
  isSupported: (name: string) => boolean
}>

const CapabilitiesContext = createContext<CapabilitiesContextType>()

export function CapabilitiesProvider(props: { endpoint?: string; children: JSX.Element }) {
  const [data, setData] = createSignal<BridgeCapabilities | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  const [tick, setTick] = createSignal(0)

  const refresh = async () => {
    if (!props.endpoint) return
    try {
      const response = await fetch(`${props.endpoint}/api/neko/capabilities`)
      if (!response.ok) throw new Error(`capabilities query failed: ${response.status}`)
      const parsed = (await response.json()) as BridgeCapabilities
      if (typeof parsed.protocol !== "number" || parsed.protocol > 1) {
        throw new Error(`unsupported capabilities protocol: ${parsed.protocol}`)
      }
      setData(parsed)
      setError(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Fetch on mount and on manual refresh; poll every 30s to catch model changes.
  void refresh()
  const timer = setInterval(() => void refresh(), 30_000)
  onCleanup(() => clearInterval(timer))
  void tick // reactive dependency for manual refresh

  const isSupported = (name: string) => {
    const caps = data()
    return caps?.global[name]?.status === "supported" || caps?.global[name]?.status === "partial"
  }

  return (
    <CapabilitiesContext.Provider
      value={{
        data,
        error,
        refresh: () => {
          setTick((t) => t + 1)
          void refresh()
        },
        isSupported,
      }}
    >
      {props.children}
    </CapabilitiesContext.Provider>
  )
}

export function useCapabilities() {
  const ctx = useContext(CapabilitiesContext)
  if (!ctx) throw new Error("useCapabilities must be used within CapabilitiesProvider")
  return ctx
}
