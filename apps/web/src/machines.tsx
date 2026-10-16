import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { api, ApiContext, connectApi, type Api, type Connection, type Me } from "./api";

type Machine = { instance: string; id: string; label: string; api: Api; close?: () => void; connection?: Connection };
type Machines = { active: Machine; profiles: Machine[]; select: (id: string) => void; add: (machine: Machine) => void; remove: () => void };
const local: Machine = { instance: "direct", id: "direct", label: "This host", api };
const MachinesContext = createContext<Machines | null>(null);
export const useMachines = () => useContext(MachinesContext)!;
const routeMachine = () => window.location.hash.match(/^#\/machines\/([^/]+)/)?.[1] ?? "direct";

export function MachineProvider({ children }: { children: ReactNode }) {
  // Keys, content, and machine profiles live in tab memory, never browser storage.
  const [profiles, setProfiles] = useState<Machine[]>([local]);
  const [activeId, setActiveId] = useState(routeMachine);
  const active = profiles.find(profile => profile.id === activeId);
  useEffect(() => {
    const changed = () => setActiveId(routeMachine());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  function select(id: string) { setActiveId(id); window.location.hash = id === "direct" ? "/" : `/machines/${id}`; }
  function add(machine: Machine) {
    profiles.find(profile => profile.id === machine.id)?.close?.();
    setProfiles(previous => [...previous.filter(profile => profile.id !== machine.id), machine]);
    select(machine.id);
  }
  function remove() {
    active?.close?.();
    setProfiles(previous => previous.filter(profile => profile.id !== activeId || profile.id === "direct"));
    select("direct");
  }
  const value = { active: active ?? { ...local, id: activeId, label: "Unpaired machine" }, profiles, select, add, remove };
  return <MachinesContext.Provider value={value}>
    {active ? <ApiContext.Provider value={active.api}><div className="machine-root" key={active.instance}>{children}</div></ApiContext.Provider> : <main className="login">
      <h1>Connect this machine</h1><p>This link belongs to a machine that is not paired in this browser tab.</p><MachinePicker expanded />
    </main>}
  </MachinesContext.Provider>;
}

export function MachinePicker({ expanded = false }: { expanded?: boolean }) {
  const machines = useMachines();
  const identity = useId();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [open, setOpen] = useState(expanded);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [machineId, setMachineId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function pair(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    let connected: ReturnType<typeof connectApi> | undefined;
    try {
      const endpoint = new URL(url.trim());
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) && endpoint.protocol === "http:";
      if ((!local && endpoint.protocol !== "https:") || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash)
        throw new Error("Use a bare HTTPS host or relay address.");
      const connection: Connection = { id: crypto.randomUUID(), label: label.trim(), url: endpoint.origin, token: token.trim(), ...(machineId.trim() ? { relay: { machineId: machineId.trim() } } : {}) };
      connected = connectApi(connection);
      const me = await connected.api<Me>("/me");
      if (!mounted.current) { connected.close(); return; }
      connection.id = me.machine?.id ?? connection.id;
      connection.label = label.trim() || me.machine?.label || endpoint.hostname;
      machines.add({ instance: crypto.randomUUID(), id: connection.id, label: connection.label, connection, ...connected });
      setToken(""); setOpen(false);
    } catch (error) { connected?.close(); setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="machine-picker">
    <label htmlFor={`${identity}-active-machine`}>Machine</label>
    <div className="machine-select">
      <select id={`${identity}-active-machine`} aria-label="Selected machine" value={machines.active.id} onChange={event => machines.select(event.target.value)}>
        {!machines.profiles.some(profile => profile.id === machines.active.id) && <option value={machines.active.id}>Unpaired machine</option>}
        {machines.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
      </select>
      <button className="icon-button" aria-label="Add machine" title="Add machine" disabled={busy} onClick={() => setOpen(!open)}>{open ? <X size={18} /> : <Plus size={18} />}</button>
    </div>
    {open && <form className="machine-pair" onSubmit={pair}>
      <label htmlFor={`${identity}-machine-label`}>Machine name (optional)</label><input id={`${identity}-machine-label`} value={label} onChange={event => setLabel(event.target.value)} placeholder="Laptop or cloud" maxLength={80} />
      <label htmlFor={`${identity}-machine-address`}>Host or relay address</label><input id={`${identity}-machine-address`} value={url} onChange={event => setUrl(event.target.value)} type="url" placeholder="https://host.example.com" required />
      <label htmlFor={`${identity}-relay-machine`}>Relay machine ID (optional)</label><input id={`${identity}-relay-machine`} value={machineId} onChange={event => setMachineId(event.target.value)} placeholder="For relay connections" autoComplete="off" />
      <label htmlFor={`${identity}-machine-key`}>Device key</label><input id={`${identity}-machine-key`} value={token} onChange={event => setToken(event.target.value)} type="password" autoComplete="off" required />
      <p className="quiet">Pairings stay in this tab’s memory. Reconnect after closing or reloading. Relay traffic is encrypted to the machine.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? "Connecting…" : "Connect machine"}</button>
    </form>}
  </div>;
}
