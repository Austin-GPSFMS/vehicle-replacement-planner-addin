/**
 * Vehicle Replacement Planner — main app.
 *
 *   Header:   title · group picker · Settings · Export CSV · Run scan
 *   Criteria: mileage slider (on/off) · age slider (on/off) · horizon · look-back
 *   Banners:  standalone, errors, VIN-decoder fallback, progress
 *   Results:  Summary tiles · search + verdict tabs · vehicle table
 *
 * Same Zenith vocabulary as Recall & Harness Swap / Intelligent Zoning so the
 * page reads native inside MyGeotab. Sliders re-evaluate the fetched data
 * locally; only Run scan and a look-back change touch the API.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, ProgressBar, SearchInput, Tabs, TextInput, ToggleButton } from "@geotab/zenith";
import type { Criteria, GeotabApi, GeotabGroup, GeotabPageState, Progress, ScanMeta, Settings, VehicleRow, Verdict } from "./types";
import { Pacer, clearVinCache, fetchGroups, fetchSession, friendlyError } from "./api/geotab";
import { buildRows, runScan, type VehicleData } from "./utils/scan";
import { exportRowsCsv } from "./utils/export";
import { VERDICT_LABEL, VERDICT_ORDER } from "./utils/labels";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./utils/storage";
import { demoVehicleData, makeDemoFleet } from "./utils/demo";
import { formatDateTime } from "./utils/format";
import { CriteriaBar } from "./components/CriteriaBar";
import { GroupFilterPicker } from "./components/GroupFilterPicker";
import { Summary } from "./components/Summary";
import { VehicleTable } from "./components/VehicleTable";
import { ErrorBoundary } from "./components/ErrorBoundary";

interface AppProps {
  api: GeotabApi | null;
  pageState: GeotabPageState | null;
  /** Bumped by the add-in's focus() so a returning user gets fresh data. */
  focusNonce: number;
}

export default function App({ api, pageState: _pageState, focusNonce }: AppProps) {
  const insideMyGeotab = api != null;

  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  useEffect(() => saveSettings(settings), [settings]);
  const [showSettings, setShowSettings] = useState(false);

  const [isScanning, setIsScanning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [data, setData] = useState<VehicleData[]>([]);
  const [meta, setMeta] = useState<ScanMeta | null>(null);
  const [groupsById, setGroupsById] = useState<Map<string, GeotabGroup>>(() => new Map());
  const [myGeotabBase, setMyGeotabBase] = useState("");
  const cancelRef = useRef(false);
  const lastScanNonce = useRef<number>(-1);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [search, setSearch] = useState("");
  const [verdict, setVerdict] = useState<Verdict | "all">("sell");

  // Device deep-link base + groups for the picker (one call each, up front).
  useEffect(() => {
    if (!api) return;
    void fetchSession(api).then((s) => {
      if (!s) return;
      const host = s.server.replace(/^https?:\/\//, "").replace(/\/$/, "");
      setMyGeotabBase(`https://${host}/${s.database}/#device,id:`);
    });
    void fetchGroups(api, new Pacer(1000))
      .then(setGroupsById)
      .catch((e) => console.warn("[VRP] groups:", e));
  }, [api]);

  // ---- Scan ----
  const onScan = useCallback(async () => {
    if (!api || isScanning) return;
    setScanErr(null);
    cancelRef.current = false;
    setIsScanning(true);
    try {
      const res = await runScan(api, settingsRef.current, setProgress, () => cancelRef.current);
      setData(res.data);
      setMeta(res.meta);
      setGroupsById(res.groupsById);
    } catch (e) {
      if (!/^Cancelled$/.test(String((e as Error)?.message ?? e))) setScanErr(friendlyError(e));
    } finally {
      setIsScanning(false);
      setProgress(null);
    }
  }, [api, isScanning]);

  // Auto-run on first load and whenever MyGeotab re-focuses the page.
  useEffect(() => {
    if (!api) {
      // Standalone preview: synthetic fleet so the page can be designed/reviewed outside MyGeotab.
      const fleet = makeDemoFleet();
      setData(demoVehicleData(fleet));
      setGroupsById(new Map(fleet.groups.map((g) => [g.id, g])));
      setMeta({
        devicesTotal: fleet.devices.length,
        devicesInScope: fleet.devices.length,
        vinsDecoded: Object.keys(fleet.vinTable).length,
        vinsMissing: fleet.devices.filter((d) => !d.vehicleIdentificationNumber).length,
        vinDecodeAvailable: true,
        odometerReadings: fleet.devices.length,
        baselineReadings: fleet.devices.length,
        deepLookups: 0,
        rowsScanned: 0,
        apiCalls: 0,
        ranAt: Date.now(),
        lookbackMonths: settingsRef.current.criteria.lookbackMonths,
      });
      return;
    }
    if (lastScanNonce.current === focusNonce) return;
    lastScanNonce.current = focusNonce;
    void onScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, focusNonce]);

  // ---- Evaluate (pure, instant) ----
  const now = useMemo(() => new Date(meta?.ranAt ?? Date.now()), [meta?.ranAt]);
  const rows: VehicleRow[] = useMemo(() => {
    const all = buildRows(data, settings.criteria, now);
    return settings.includeNoVin ? all : all.filter((r) => r.vinStatus !== "missing");
  }, [data, settings.criteria, settings.includeNoVin, now]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (verdict !== "all" && r.verdict !== verdict) return false;
      if (q) {
        const hay = `${r.name} ${r.groupNames.join(" ")} ${r.year ?? ""} ${r.make} ${r.model} ${r.vin} ${r.licensePlate} ${r.comment}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, verdict]);

  const tabs = useMemo(
    () => [
      { id: "all", name: "All", quantity: rows.length },
      ...VERDICT_ORDER.map((v) => ({ id: v, name: VERDICT_LABEL[v], quantity: rows.filter((r) => r.verdict === v).length || undefined })),
    ],
    [rows]
  );

  const setCriteria = useCallback((c: Criteria) => setSettings((s) => ({ ...s, criteria: c })), []);
  const onLookbackChange = useCallback(
    (months: number) => {
      // The look-back drives the baseline instant, so it needs a fresh fetch.
      settingsRef.current = { ...settingsRef.current, criteria: { ...settingsRef.current.criteria, lookbackMonths: months } };
      if (api) void onScan();
    },
    [api, onScan]
  );
  const onGroupsChange = useCallback((ids: string[]) => setSettings((s) => ({ ...s, groupIds: ids })), []);

  return (
    <div className="vrp-page">
      <header className="vrp-page-header">
        <div>
          <h2>Vehicle Replacement Planner</h2>
          <p>
            Which vehicles have hit your fleet's mileage or age limit, and when the rest will get there — projected
            from each vehicle's own {settings.criteria.lookbackMonths}-month average.
            {meta && (
              <span className="vrp-muted">
                {" "}
                Scanned {formatDateTime(meta.ranAt)} · {meta.devicesInScope.toLocaleString()} vehicles ·{" "}
                {meta.odometerReadings.toLocaleString()} with a current odometer · {meta.baselineReadings.toLocaleString()} with a baseline
                {meta.apiCalls ? ` · ${meta.apiCalls.toLocaleString()} API calls (${meta.rowsScanned.toLocaleString()} readings scanned, ${meta.deepLookups.toLocaleString()} individual lookups)` : ""}
              </span>
            )}
          </p>
        </div>
        <div className="vrp-actions">
          {groupsById.size > 0 && (
            <div className="vrp-groups-picker">
              <GroupFilterPicker groupsById={groupsById} initialGroupIds={settings.groupIds} onChange={onGroupsChange} />
            </div>
          )}
          <Button type="tertiary" onClick={() => setShowSettings((s) => !s)}>
            {showSettings ? "Hide settings" : "Settings"}
          </Button>
          <Button
            type="secondary"
            onClick={() => exportRowsCsv(filtered, settings.criteria, verdict === "all" ? "vehicle-replacement" : `vehicle-replacement-${verdict}`)}
            disabled={!filtered.length || isScanning}
          >
            Export CSV
          </Button>
          {isScanning ? (
            <Button type="secondary" onClick={() => (cancelRef.current = true)}>
              Cancel
            </Button>
          ) : (
            <Button type="primary" onClick={onScan} disabled={!insideMyGeotab}>
              {meta && insideMyGeotab ? "Re-run scan" : "Run scan"}
            </Button>
          )}
        </div>
      </header>

      {showSettings && (
        <section className="vrp-settings">
          <div className="vrp-settings-head">
            <h3>Scan settings</h3>
            <div style={{ display: "flex", gap: 8 }}>
              <Button type="tertiary" onClick={() => setSettings({ ...DEFAULT_SETTINGS, criteria: settings.criteria, groupIds: settings.groupIds })}>
                Reset
              </Button>
              <Button type="secondary" onClick={() => setShowSettings(false)}>
                Close
              </Button>
            </div>
          </div>
          <div className="vrp-settings-grid">
            <TextInput
              label="Max API calls per minute"
              type="number"
              value={String(settings.callsPerMinute)}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setSettings((s) => ({ ...s, callsPerMinute: Number.isFinite(n) ? Math.max(100, Math.min(950, n)) : s.callsPerMinute }));
              }}
              assistive="MyGeotab allows ~1000 per user per minute; the scan paces itself under this cap."
            />
            <TextInput
              label="Max individual lookups per pass"
              type="number"
              value={String(settings.deepLookupMax)}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setSettings((s) => ({ ...s, deepLookupMax: Number.isFinite(n) ? Math.max(0, Math.min(2000, n)) : s.deepLookupMax }));
              }}
              assistive="Vehicles with no odometer record in the fleet-wide windows (silent 14+ days now, or nothing within a week of the baseline) get one call each, up to this many. The rest show as no data."
            />
            <label className="vrp-toggle">
              <ToggleButton title="Show vehicles with no VIN" value={settings.includeNoVin} onChange={(v) => setSettings((s) => ({ ...s, includeNoVin: v }))} />
              <span>Show vehicles with no VIN (they can only be judged on mileage)</span>
            </label>
            <div>
              <Button
                type="tertiary"
                onClick={() => {
                  clearVinCache();
                  if (api) void onScan();
                }}
              >
                Clear VIN cache &amp; re-scan
              </Button>
              <p className="vrp-criterion-hint">Decoded make/model/year is cached in this browser; clear it if a VIN was corrected in MyGeotab.</p>
            </div>
          </div>
        </section>
      )}

      <ErrorBoundary label="criteria">
        <CriteriaBar criteria={settings.criteria} onChange={setCriteria} busy={isScanning} onLookbackChange={onLookbackChange} />
      </ErrorBoundary>

      <div className="vrp-banners">
        {!insideMyGeotab && (
          <Banner type="info" header="Standalone preview">
            Showing a synthetic fleet. Open this page from inside MyGeotab to evaluate live vehicles.
          </Banner>
        )}
        {scanErr && (
          <Banner type="error" header="Scan failed">
            {scanErr}
          </Banner>
        )}
        {meta && !meta.vinDecodeAvailable && (
          <Banner type="warning" header="MyGeotab VIN decoder unavailable">
            DecodeVins failed ({meta.vinDecodeError ?? "no response"}), so make and model are blank and the model year
            comes from the VIN's year code only. Geotab labels DecodeVins "not fully supported"; if it has been removed,
            make/model need another source.
          </Banner>
        )}
        {meta && meta.vinsMissing > 0 && (
          <Banner type="info" header={`${meta.vinsMissing.toLocaleString()} vehicle${meta.vinsMissing === 1 ? "" : "s"} with no VIN`}>
            They show as "Missing VIN" and are evaluated on mileage only. Add the VIN on the vehicle in MyGeotab to get
            make, model, year and the age criterion.
          </Banner>
        )}
        {progress && (
          <div className="vrp-progress">
            <span>{progress.text}</span>
            <div className="vrp-progress-bar">
              {progress.pct == null ? <ProgressBar min={0} max={100} now={100} /> : <ProgressBar min={0} max={100} now={progress.pct} />}
            </div>
          </div>
        )}
      </div>

      {(meta || rows.length > 0) && (
        <ErrorBoundary label="results">
          <Summary rows={rows} meta={meta} criteria={settings.criteria} active={verdict} onPick={setVerdict} />

          <div className="vrp-toolbar">
            <SearchInput value={search} onChange={setSearch} placeholder="Search asset, group, make, model, VIN, plate…" ariaLabel="Search" />
            <span className="vrp-muted">
              {filtered.length.toLocaleString()} of {rows.length.toLocaleString()} vehicles
            </span>
          </div>

          <Tabs tabs={tabs} activeTabId={verdict} onTabChange={(id) => setVerdict(id as Verdict | "all")} />

          <VehicleTable rows={filtered} criteria={settings.criteria} busy={isScanning} myGeotabBase={myGeotabBase} />
        </ErrorBoundary>
      )}
    </div>
  );
}
