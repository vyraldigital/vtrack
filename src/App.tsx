import { useState, useEffect, useRef } from 'react'
import { supabase } from './supabase'
import { Fingerprint, LogOut, AlertTriangle, Clock, RefreshCw } from 'lucide-react'

type Profile = {
  name: string
  email: string
  role: string
  roles?: string[] | null
  status?: string | null
  activity_tracking_enabled: boolean
}

type DeviceInfo = {
  fingerprint: string
  deviceName: string
  deviceOs: string
  appVersion: string
}

type Permissions = {
  screen: 'unknown' | 'granted' | 'denied' | 'limited'
  accessibility: 'unknown' | 'granted' | 'denied' | 'limited'
}

type Session = {
  id: string
  device_id: string | null
  clock_in: string
  status: 'active' | 'completed' | 'cancelled'
}

type TodaySession = {
  id: string
  clock_in: string
  clock_out: string | null
  total_minutes: number | null
  status: string
}

export default function App() {
  const [session, setSession] = useState<any>(null)
  const [updaterStatus, setUpdaterStatus] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [consentGranted, setConsentGranted] = useState(false)
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null)
  const [permissions, setPermissions] = useState<Permissions>({ screen: 'unknown', accessibility: 'unknown' })
  const [activeSession, setActiveSession] = useState<Session | null>(null)
  const [activeWebTask, setActiveWebTask] = useState<string>('No active web task')
  const [timerStr, setTimerStr] = useState('00:00:00')
  const [recoverySession, setRecoverySession] = useState<any>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState('')
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null)
  const [heartbeatFailed, setHeartbeatFailed] = useState(false)
  const [todaySessions, setTodaySessions] = useState<TodaySession[]>([])
  const [showSessionHistory, setShowSessionHistory] = useState(false)
  const [activityStatus, setActivityStatus] = useState<'Active' | 'Idle' | 'Disabled'>('Disabled')
  const [activePercentage, setActivePercentage] = useState<number>(0)
  // Shown right after clock-in when there's no in-progress task to resume.
  const [clockInNudge, setClockInNudge] = useState<string | null>(null)

  useEffect(() => {
    if (window.electronAPI?.onPowerStateChange) {
      return window.electronAPI.onPowerStateChange((state: string) => {
        if (state === 'suspend') {
          console.log('System suspended')
        } else if (state === 'resume') {
          console.log('System resumed')
        }
      })
    }
  }, [])

  useEffect(() => {
    if (window.electronAPI?.getAppVersion) {
      window.electronAPI.getAppVersion().then(setAppVersion)
    }

    if (window.electronAPI?.onUpdaterStatus) {
      return window.electronAPI.onUpdaterStatus((text: string) => {
        setUpdaterStatus(text)
      })
    }
  }, [])

  // Phase 4D State
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [queueStats, setQueueStats] = useState({ pendingCount: 0, failedCount: 0 })
  const syncLoopIntervalRef = useRef<any | null>(null)
  
  const heartbeatIntervalRef = useRef<any | null>(null)
  const clockTimerIntervalRef = useRef<any | null>(null)
  const webTaskIntervalRef = useRef<any | null>(null)
  const screenshotTimeoutRef = useRef<any | null>(null)
  const activityTrackerIntervalRef = useRef<any | null>(null)
  const idleMinutesRef = useRef<number>(0)
  // True once the current idle stretch has been flagged on the active task timer,
  // so we flag a long idle gap only once (reset when activity resumes).
  const timerIdleFlaggedRef = useRef<boolean>(false)
  // Minutes of continuous no-input before a running task timer is flagged for review.
  const TIMER_IDLE_FLAG_MINUTES = 30
  // Minutes of real activity with NO task timer running before we auto-resume the
  // editor's in-progress task (or nudge them to start one). Catches "paused the
  // timer by accident and kept working" — untracked work should never accumulate.
  const UNTRACKED_WORK_MINUTES = 10
  const untrackedActiveMinRef = useRef<number>(0)
  // Minutes of continuous no-input before we AUTO CLOCK OUT (capped at last
  // activity) — long enough to ignore normal breaks (lunch etc.).
  const ATTENDANCE_IDLE_CLOCKOUT_MINUTES = 60
  const idleClockedOutRef = useRef<boolean>(false)

  // ── Break mode ────────────────────────────────────────────────────────────
  // A break is a declared interval; the task timer and attendance session keep
  // running through it (breaks are paid work here), and the server excuses the
  // interval from the 30-minute dead-gap trim. Two thresholds:
  //   50m → friendly nudge (once)
  //   60m → wrap up: if there was NO real input the person is genuinely away, so
  //         we credit 30m and clock out; if they ARE active they simply forgot to
  //         switch back, so we keep every minute and flag it for review.
  const BREAK_NUDGE_MINUTES = 50
  const BREAK_LIMIT_MINUTES = 60
  const BREAK_CREDIT_MINUTES = 30
  const [activeBreak, setActiveBreak] = useState<{ id: string; started_at: string } | null>(null)
  const [breakStr, setBreakStr] = useState('0:00')
  const [breakNudged, setBreakNudged] = useState(false)
  const [breakBusy, setBreakBusy] = useState(false)
  const [breaksToday, setBreaksToday] = useState<{ count: number; minutes: number }>({ count: 0, minutes: 0 })
  const activeBreakRef = useRef<{ id: string; started_at: string } | null>(null)
  // started_at comes from the SERVER clock; Date.now() is this machine's. Even a
  // second of drift (or the RPC round trip) made the timer render "-1:-1" on the
  // first tick of every break. Worse, a machine running FAST would compute a huge
  // elapsed and instantly auto-end the break — we've already seen a PC 9 hours out.
  // So once a break starts we measure from a LOCAL anchor and ignore the skew.
  const breakAnchorRef = useRef<{ id: string; localStart: number } | null>(null)
  const breakLimitHandledRef = useRef<boolean>(false)

  const activeSessionRef = useRef<any>(null)
  const sessionRef = useRef<any>(null)
  const profileRef = useRef<any>(null)
  const activeWebTaskRef = useRef<string>('No active web task')
  const activeWebTaskIdRef = useRef<string | null>(null)
  const activeTimeSessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    activeSessionRef.current = activeSession
  }, [activeSession])

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  useEffect(() => {
    profileRef.current = profile
  }, [profile])

  // 1. Initial Load & Auth Listeners
  useEffect(() => {
    // Check local consent status
    const consent = localStorage.getItem('vops_tracker_consent') === 'true'
    setConsentGranted(consent)

    // Load electron device info & permissions
    if (window.electronAPI) {
      window.electronAPI.getDeviceInfo().then(setDeviceInfo)
      window.electronAPI.getPermissionsStatus().then(setPermissions)

      // Listen for system wake/resume
      window.electronAPI.onPowerStateChange((state) => {
        if (state === 'resume') {
          console.log('System resumed from sleep, refreshing state...')
          checkActiveSession()
          refreshPermissions()
        }
      })
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) {
        loadProfile(session.user.id)
      } else {
        setLoading(false)
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) {
        loadProfile(session.user.id)
      } else {
        setProfile(null)
        setActiveSession(null)
        setLoading(false)
      }
    })

    return () => {
      subscription.unsubscribe()
      stopAllTrackers()
    }
  }, [])

  // Phase 4D: Track Online Status
  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    
    // Also start sync manager on mount
    startSyncManager()

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      if (syncLoopIntervalRef.current) clearInterval(syncLoopIntervalRef.current)
    }
  }, [])

  // Phase 4D: Sync Manager Background Loop
  const startSyncManager = () => {
    if (syncLoopIntervalRef.current) clearInterval(syncLoopIntervalRef.current)

    const processQueue = async () => {
      if (!navigator.onLine || !window.electronAPI) return
      
      try {
        const stats = await window.electronAPI.getQueueStats()
        setQueueStats(stats)
        
        if (stats.pendingCount === 0) return

        const queue = await window.electronAPI.getSyncQueue()
        for (const item of queue) {
          if (item.status !== 'pending') continue
          
          let success = false
          let errMsg = ''

          try {
            if (item.type === 'activity_log') {
              const { error } = await supabase.from('activity_logs').insert(item.payload_json)
              if (error) {
                if (error.code === '23505') success = true // Deduplicate via idempotency_key
                else throw error
              } else success = true
            } else if (item.type === 'screenshot') {
              const readResult = await window.electronAPI.readTempScreenshot(item.file_path)
              if (!readResult.success) {
                // If the local file is gone — temp cleared, disk cleaned, machine
                // rebooted — there is nothing left to upload and no number of
                // retries can change that. Drop it, or the queue sticks on this
                // item forever: 5 tries → "failed" → the person hits Retry → 5
                // more. Any other read error is treated as transient and retried.
                if (/ENOENT|no such file/i.test(readResult.error || '')) {
                  console.warn('Dropping screenshot whose local file is gone:', item.file_path)
                  await window.electronAPI.deleteQueueItem(item.local_id)
                  continue
                }
                throw new Error(readResult.error || 'Failed to read local screenshot')
              }
              
              const { error: uploadError } = await supabase.storage.from('desktop-screenshots').upload(item.payload_json.storage_path, readResult.buffer, { contentType: 'image/jpeg', upsert: true })
              if (uploadError) throw uploadError
              
              const { error: dbError } = await supabase.from('screenshots').insert(item.payload_json)
              if (dbError) {
                if (dbError.code === '23505') success = true
                else throw dbError
              } else success = true
            } else if (item.type === 'clock_out') {
              // Direct update for offline clock-out syncing
              const { error: updateError } = await supabase.from('attendance_sessions').update({
                status: 'completed',
                clock_out: item.payload_json.clock_out,
                total_minutes: item.payload_json.total_minutes,
                sync_status: 'offline_synced'
              }).eq('id', item.payload_json.session_id)

              if (updateError) throw updateError
              success = true
            } else if (item.type === 'timer_heartbeat') {
              // Keep the active task timer alive (offline-buffered heartbeat)
              const { error } = await supabase.rpc('desktop_timer_heartbeat', {
                p_session_id: item.payload_json.session_id,
                p_at: item.payload_json.at
              })
              if (error) throw error
              success = true
            } else if (item.type === 'timer_stop') {
              // Stop the task timer at clock-out (offline-buffered)
              const { error } = await supabase.rpc('desktop_timer_stop', {
                p_session_id: item.payload_json.session_id,
                p_end_time: item.payload_json.end_time
              })
              if (error) throw error
              success = true
            } else if (item.type === 'timer_flag') {
              // Flag a long idle gap on the task timer for admin review
              const { error } = await supabase.rpc('desktop_timer_flag', {
                p_session_id: item.payload_json.session_id,
                p_reason: item.payload_json.reason
              })
              if (error) throw error
              success = true
            }
          } catch (e: any) {
            console.error('Sync item failed:', e)
            errMsg = e.message
          }

          if (success) {
            await window.electronAPI.deleteQueueItem(item.local_id)
          } else {
            const newRetries = item.retry_count + 1
            await window.electronAPI.updateQueueItem(item.local_id, {
              retry_count: newRetries,
              status: newRetries >= 5 ? 'failed' : 'pending',
              error_message: errMsg,
              last_attempt_at: new Date().toISOString()
            })
          }
        }
        
        // Refresh stats after processing
        setQueueStats(await window.electronAPI.getQueueStats())
        setLastSyncTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      } catch(e) {
        console.error('Sync manager error:', e)
      }
    }
    
    // Run once immediately, then every 15 seconds
    processQueue()
    syncLoopIntervalRef.current = setInterval(processQueue, 15000)
  }

  // 2. Clock timer and tasks poll when session status changes
  useEffect(() => {
    if (activeSession && activeSession.status === 'active') {
      startClockTimer()
      startWebTaskPoll()
      startHeartbeat()
      startScreenshotLoop()
      startActivityTrackingLoop()
    } else {
      stopAllTrackers()
    }
  }, [activeSession])

  const loadProfile = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('name, email, role, roles, status, activity_tracking_enabled')
        .eq('id', userId)
        .maybeSingle()

      if (error) throw error

      // No row despite no error means the session token isn't authenticating —
      // e.g. it expired, or a token refresh got rate-limited, so the request hit
      // RLS as an anonymous user and the `TO authenticated` profiles policy
      // returned nothing. Recover with a clean re-login instead of surfacing the
      // cryptic "Cannot coerce the result to a single JSON object" this used to
      // throw when `.single()` got zero rows.
      if (!data) {
        setAuthError('Your session expired. Please sign in again.')
        await supabase.auth.signOut()
        return
      }

      // Any vOps account may use the tracker — role no longer gates access (HR and
      // Sales were previously refused). Only a DEACTIVATED account is turned away;
      // the desktop_clock_in RPC enforces the same rule server-side. Checking for
      // an explicit 'inactive' (not `!== 'active'`) means a null/absent status
      // never locks anyone out.
      if (data.status === 'inactive') {
        setAuthError('This account has been deactivated. Please contact your admin.')
        await supabase.auth.signOut()
        return
      }

      setProfile(data)
      // Check if user has an existing active session on load
      await checkActiveSession(userId)
      // Load today's completed sessions for total time display
      await fetchTodaySessions(userId)
    } catch (err: any) {
      console.error(err)
      let errorMsg = err.message || 'Failed to load profile details.'
      const m = (err.message || '').toLowerCase()
      if (m.includes('fetch') || m.includes('network') || m.includes('failed to connect')) {
        errorMsg = 'Unable to connect to vOps server. Please check your internet connection.'
      } else if (err.status === 429 || m.includes('rate limit')) {
        errorMsg = 'Too many attempts right now. Please wait a minute and try again.'
      }
      setAuthError(errorMsg)
    } finally {
      setLoading(false)
    }
  }

  const checkActiveSession = async (userId = session?.user?.id) => {
    if (!userId) return
    try {
      const { data, error } = await supabase
        .from('attendance_sessions')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'active')
        .maybeSingle()

      if (error && error.code !== 'PGRST116') throw error

      if (data) {
        // Active session exists. Check if it is stale (>10m no update)
        const lastUpdate = new Date(data.updated_at).getTime()
        const diffMins = Math.floor((Date.now() - lastUpdate) / 60000)

        if (diffMins > 10) {
          // Stale session detected, save in state to prompt user
          setRecoverySession(data)
        } else {
          // Normal active session, restore it
          setActiveSession(data)
        }
      } else {
        setActiveSession(null)
        setRecoverySession(null)
      }
    } catch (err) {
      console.error('Error checking active session:', err)
    }
  }

  const fetchTodaySessions = async (userId = session?.user?.id) => {
    if (!userId) return
    try {
      // Get today's date boundaries in UTC
      const now = new Date()
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()

      const { data, error } = await supabase
        .from('attendance_sessions')
        .select('id, clock_in, clock_out, total_minutes, status')
        .eq('user_id', userId)
        .gte('clock_in', startOfDay)
        .lt('clock_in', endOfDay)
        .order('clock_in', { ascending: true })

      if (error) throw error
      setTodaySessions(data || [])
    } catch (err) {
      console.error('Error fetching today sessions:', err)
    }
  }

  const refreshPermissions = async () => {
    if (window.electronAPI) {
      const p = await window.electronAPI.getPermissionsStatus()
      setPermissions(p)
      return p
    }
    return permissions
  }

  const requestPermission = async (type: 'screen' | 'accessibility') => {
    if (window.electronAPI) {
      const p = await window.electronAPI.requestSystemPermissions(type)
      setPermissions(p)
    }
  }

  // 3. Authenticate Login
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError('')
    setLoading(true)

    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
    } catch (err: any) {
      const m = (err.message || '').toLowerCase()
      let msg = err.message || 'Login failed. Please check credentials.'
      // Friendly message on Supabase auth throttling — tells users to wait
      // rather than mash the button, which is what exhausts the limit.
      if (err.status === 429 || m.includes('rate limit')) {
        msg = 'Too many sign-in attempts. Please wait a minute, then try again.'
      }
      setAuthError(msg)
      setLoading(false)
    }
  }

  const handleLogout = async () => {
    if (activeSession) {
      if (!confirm('You are clocked in. Logging out will Clock You Out first. Continue?')) {
        return
      }
      await handleClockOut()
    }
    stopAllTrackers()
    await supabase.auth.signOut()
    setEmail('')
    setPassword('')
  }

  const handleGrantConsent = () => {
    localStorage.setItem('vops_tracker_consent', 'true')
    setConsentGranted(true)
  }

  // 4. Clock In / Out Operations
  const handleClockIn = async () => {
    if (!deviceInfo) return
    setSyncing(true)
    setSyncError('')

    try {
      const currentPermissions = await refreshPermissions()

      // Call secure database RPC for clock in
      const { data: sess, error: sessError } = await supabase.rpc('desktop_clock_in', {
        p_fingerprint: deviceInfo.fingerprint,
        p_device_name: deviceInfo.deviceName,
        p_device_os: deviceInfo.deviceOs,
        p_app_version: deviceInfo.appVersion,
        p_screen_status: currentPermissions.screen,
        p_accessibility_status: currentPermissions.accessibility
      })

      if (sessError) throw sessError

      setActiveSession(sess)
      setRecoverySession(null)
      // Fresh session — re-arm the idle auto-clock-out guard, ask for notification
      // permission (so the auto clock-out can surface a native popup).
      idleClockedOutRef.current = false
      idleMinutesRef.current = 0
      try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission() } catch {}
      // Refresh today's sessions to include the new active session
      await fetchTodaySessions()

      // Smart resume: if the editor already has a task in progress, resume its
      // timer automatically. Otherwise show a gentle nudge to start one.
      setClockInNudge(null)
      try {
        const { data: resume } = await supabase.rpc('desktop_timer_resume')
        if (resume?.resumed && resume.id) {
          activeTimeSessionIdRef.current = resume.id
          if (resume.title) {
            setActiveWebTask(resume.title)
            activeWebTaskRef.current = resume.title
          }
          if (resume.task_id) activeWebTaskIdRef.current = resume.task_id
          timerIdleFlaggedRef.current = false
        } else if (resume && !resume.already_active) {
          setClockInNudge('Clocked in — open vOps and start a task to track your time.')
        }
      } catch (e) {
        console.error('Resume-on-clock-in check failed:', e)
      }
    } catch (err: any) {
      console.error(err)
      let errorMsg = err.message || 'Failed to Clock In.'
      if (err.message && (err.message.toLowerCase().includes('idx_one_active_attendance_session') || err.message.toLowerCase().includes('duplicate key'))) {
        errorMsg = 'Failed to Clock In: You already have an active attendance session running elsewhere.'
      } else if (err.message && (err.message.toLowerCase().includes('fetch') || err.message.toLowerCase().includes('network') || err.message.toLowerCase().includes('failed to connect'))) {
        errorMsg = 'Unable to connect to vOps server. Please check your internet connection and retry Clock In.'
      }
      setSyncError(errorMsg)
    } finally {
      setSyncing(false)
    }
  }

  // ── Break mode handlers ───────────────────────────────────────────────────
  const refreshBreaksToday = async (userId = session?.user?.id) => {
    if (!userId) return
    const since = new Date(); since.setHours(0, 0, 0, 0)
    try {
      const { data } = await supabase
        .from('work_breaks')
        .select('started_at, ended_at')
        .eq('user_id', userId)
        .gte('started_at', since.toISOString())
      const rows = data ?? []
      const minutes = rows.reduce((sum, b: any) => {
        if (!b.ended_at) return sum
        return sum + Math.max(0, Math.round((new Date(b.ended_at).getTime() - new Date(b.started_at).getTime()) / 60000))
      }, 0)
      setBreaksToday({ count: rows.length, minutes })
    } catch { /* table may not exist yet — breaks are a bonus signal */ }
  }

  const startBreak = async () => {
    if (!activeSession || activeBreakRef.current) return
    setBreakBusy(true)
    try {
      const { data, error } = await supabase.rpc('desktop_break_start')
      if (error) throw error
      const brk = data as { id: string; started_at: string }
      setActiveBreak(brk); activeBreakRef.current = brk
      breakAnchorRef.current = { id: brk.id, localStart: Date.now() }
      setBreakNudged(false); breakLimitHandledRef.current = false
    } catch (e: any) {
      setSyncError(e?.message || 'Could not start the break. Please try again.')
    } finally { setBreakBusy(false) }
  }

  const endBreak = async (reason: 'manual' | 'auto_60m' | 'clock_out' = 'manual') => {
    if (!activeBreakRef.current) return
    setBreakBusy(true)
    try {
      await supabase.rpc('desktop_break_end', { p_reason: reason })
    } catch (e) {
      console.error('End break failed:', e)
    } finally {
      setActiveBreak(null); activeBreakRef.current = null
      setBreakNudged(false); breakLimitHandledRef.current = false
      setBreakBusy(false)
      refreshBreaksToday()
    }
  }

  // Fired once when a break reaches BREAK_LIMIT_MINUTES.
  const handleBreakLimit = async () => {
    const brk = activeBreakRef.current
    const currSession = activeSessionRef.current
    if (!brk) return

    // Genuinely away = a full stretch of no keyboard/mouse input.
    const away = idleMinutesRef.current >= BREAK_LIMIT_MINUTES

    if (!away) {
      // They're clearly working and just forgot to switch back — keep every
      // minute, flag the session so a human can verify it against screenshots.
      await endBreak('manual')
      const tsId = activeTimeSessionIdRef.current
      if (tsId && navigator.onLine) {
        try {
          await supabase.rpc('desktop_timer_flag', {
            p_session_id: tsId,
            p_reason: 'Break mode left on past 60m while active — verify against screenshots',
          })
        } catch { /* flagging is best-effort */ }
      }
      return
    }

    // Away: credit 30 minutes from the break start, then clock out at that moment.
    const creditedEnd = new Date(brk.started_at).getTime() + BREAK_CREDIT_MINUTES * 60000
    await endBreak('auto_60m')  // server writes ended_at = started_at + 30m
    if (!currSession || !navigator.onLine) return
    try {
      const tsId = activeTimeSessionIdRef.current
      if (tsId) {
        try { await supabase.rpc('desktop_timer_stop', { p_session_id: tsId, p_end_time: new Date(creditedEnd).toISOString() }) } catch {}
        activeTimeSessionIdRef.current = null
      }
      // Reuse the proven idle clock-out path; idle minutes are measured back from
      // the credited moment so attendance closes at break_start + 30m.
      const backdateMinutes = Math.max(0, Math.round((Date.now() - creditedEnd) / 60000))
      const { data: res } = await supabase.rpc('desktop_idle_clock_out', {
        p_session_id: currSession.id,
        p_idle_minutes: backdateMinutes,
      })
      if (res?.ok) {
        const at = new Date(res.clock_out).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        setActiveSession(null)
        stopAllTrackers()
        await fetchTodaySessions()
        const msg = `Your break ran past an hour, so we clocked you out at ${at} with 30 minutes counted. Clock back in whenever you're ready.`
        try { if ('Notification' in window && Notification.permission === 'granted') new Notification('vTrack — Break wrapped up', { body: msg }) } catch {}
        alert(msg)
      }
    } catch (e) {
      console.error('Break auto clock-out failed:', e)
    }
  }

  // Restore an open break after a relaunch/crash, and keep today's totals fresh.
  useEffect(() => {
    const uid = session?.user?.id
    if (!uid) return
    let cancelled = false
    ;(async () => {
      try {
        const { data } = await supabase
          .from('work_breaks')
          .select('id, started_at')
          .eq('user_id', uid)
          .is('ended_at', null)
          .order('started_at', { ascending: false })
          .limit(1)
        const open = data?.[0] as { id: string; started_at: string } | undefined
        if (!cancelled && open && activeSessionRef.current) {
          setActiveBreak(open); activeBreakRef.current = open
        }
      } catch { /* pre-migration — no breaks yet */ }
      if (!cancelled) refreshBreaksToday(uid)
    })()
    return () => { cancelled = true }
  }, [session?.user?.id, activeSession?.id])

  // Milliseconds this break has been running. Prefers the local anchor set when
  // the break started; falls back to the server timestamp (app relaunched
  // mid-break), and never goes negative.
  const breakElapsedMs = (brk: { id: string; started_at: string }) => {
    const anchor = breakAnchorRef.current
    if (anchor && anchor.id === brk.id) return Math.max(0, Date.now() - anchor.localStart)
    return Math.max(0, Date.now() - new Date(brk.started_at).getTime())
  }

  // Break ticker: drives the on-screen timer, the 50m nudge and the 60m wrap-up.
  useEffect(() => {
    if (!activeBreak) { setBreakStr('0:00'); return }
    const tick = async () => {
      const ms = breakElapsedMs(activeBreak)
      const mins = Math.floor(ms / 60000)
      setBreakStr(`${mins}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`)

      if (mins >= BREAK_NUDGE_MINUTES && !breakNudged) {
        setBreakNudged(true)
        try { await supabase.rpc('desktop_break_nudge') } catch { /* best-effort */ }
        try {
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('vTrack', { body: "Still on break? No rush — just tap I'm back when you return." })
          }
        } catch { /* notifications are optional */ }
      }

      if (mins >= BREAK_LIMIT_MINUTES && !breakLimitHandledRef.current) {
        breakLimitHandledRef.current = true
        await handleBreakLimit()
      }
    }
    tick()
    const iv = setInterval(tick, 1000)
    return () => clearInterval(iv)
  }, [activeBreak, breakNudged])

  const handleClockOut = async () => {
    if (!activeSession) return
    if (activeBreakRef.current) await endBreak('clock_out')
    setSyncing(true)
    setSyncError('')

    try {
      if (!navigator.onLine && window.electronAPI) {
        // Phase 4D: Offline Clock Out
        const now = new Date()
        const diffMs = now.getTime() - new Date(activeSession.clock_in).getTime()
        const totalMins = Math.max(0, Math.floor(diffMs / 60000))

        await window.electronAPI.enqueueSyncItem({
          type: 'clock_out',
          payload_json: {
            session_id: activeSession.id,
            clock_out: now.toISOString(),
            total_minutes: totalMins
          },
          idempotency_key: crypto.randomUUID()
        })

        // Auto-stop any running task timer at clock-out (offline-buffered)
        const tsIdOffline = activeTimeSessionIdRef.current
        if (tsIdOffline) {
          await window.electronAPI.enqueueSyncItem({
            type: 'timer_stop',
            payload_json: { session_id: tsIdOffline, end_time: now.toISOString() },
            idempotency_key: crypto.randomUUID()
          })
          activeTimeSessionIdRef.current = null
        }

        setActiveSession(null)
        setRecoverySession(null)
        await fetchTodaySessions()
        return
      }

      // Auto-stop any running task timer at clock-out (wall-clock end)
      const tsIdOnline = activeTimeSessionIdRef.current
      if (tsIdOnline) {
        try {
          await supabase.rpc('desktop_timer_stop', { p_session_id: tsIdOnline, p_end_time: new Date().toISOString() })
        } catch (e) {
          console.error('Timer stop on clock-out failed:', e)
        }
        activeTimeSessionIdRef.current = null
      }

      // Call secure database RPC for clock out
      const { error: updateError } = await supabase.rpc('desktop_clock_out', {
        p_session_id: activeSession.id
      })

      if (updateError) throw updateError

      setActiveSession(null)
      setRecoverySession(null)
      // Refresh today's sessions to show updated total
      await fetchTodaySessions()
    } catch (err: any) {
      console.error(err)
      let errorMsg = err.message || 'Failed to Clock Out.'
      if (err.message && (err.message.toLowerCase().includes('fetch') || err.message.toLowerCase().includes('network') || err.message.toLowerCase().includes('failed to connect'))) {
        errorMsg = 'Unable to connect to vOps server. Please check your internet connection and retry Clock Out.'
      }
      setSyncError(errorMsg)
    } finally {
      setSyncing(false)
    }
  }

  // 5. Recovery Actions (Continue or Clock Out old session)
  const handleResolveRecovery = async (action: 'continue' | 'lastseen' | 'now') => {
    if (!recoverySession) return
    setSyncing(true)
    setSyncError('')

    try {
      if (action === 'continue') {
        const { data: sess, error } = await supabase.rpc('desktop_resolve_stale_continue', {
          p_session_id: recoverySession.id
        })
        if (error) throw error
        setActiveSession(sess)
      } else if (action === 'lastseen') {
        const { error } = await supabase.rpc('desktop_resolve_stale_clockout_last_seen', {
          p_session_id: recoverySession.id
        })
        if (error) throw error
        setActiveSession(null)
      } else if (action === 'now') {
        const { error } = await supabase.rpc('desktop_resolve_stale_clockout_now', {
          p_session_id: recoverySession.id
        })
        if (error) throw error
        setActiveSession(null)
      }
      setRecoverySession(null)
      // Refresh today's sessions after recovery resolution
      await fetchTodaySessions()
    } catch (err: any) {
      console.error(err)
      setSyncError(err.message || 'Failed to resolve session.')
    } finally {
      setSyncing(false)
    }
  }

  // 6. Daemons & Interval Timers
  const startClockTimer = () => {
    if (clockTimerIntervalRef.current) clearInterval(clockTimerIntervalRef.current)

    // Fix D: Read session from ref inside the interval callback so we never capture
    // a stale `activeSession` closure from the render cycle that spawned this timer.
    const updateTimer = () => {
      const sess = activeSessionRef.current
      if (!sess) return
      const clockInTime = new Date(sess.clock_in).getTime()
      const diffMs = Date.now() - clockInTime

      const hrs = Math.floor(diffMs / 3600000)
      const mins = Math.floor((diffMs % 3600000) / 60000)
      const secs = Math.floor((diffMs % 60000) / 1000)

      setTimerStr(
        `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      )
    }

    updateTimer()
    clockTimerIntervalRef.current = setInterval(updateTimer, 1000)
  }

  const startWebTaskPoll = () => {
    if (webTaskIntervalRef.current) clearInterval(webTaskIntervalRef.current)

    const checkWebTask = async () => {
      try {
        // Fix E: Read user ID from ref — avoids a stale closure on the `session` object
        // that was captured when startWebTaskPoll() was first called (e.g. after a token refresh
        // the session object reference changes, but sessionRef.current stays fresh).
        const userId = sessionRef.current?.user?.id
        if (!userId) return
        const { data, error } = await supabase
          .from('time_sessions')
          .select('id, task_id, task:tasks(title)')
          .eq('user_id', userId)
          .eq('status', 'active')
          .maybeSingle()

        if (error && error.code !== 'PGRST116') throw error
        const prevTsId = activeTimeSessionIdRef.current
        if (data && data.task) {
          setActiveWebTask((data.task as unknown as { title: string }).title)
          activeWebTaskRef.current = (data.task as unknown as { title: string }).title
          activeWebTaskIdRef.current = data.task_id
          activeTimeSessionIdRef.current = data.id
          setClockInNudge(null) // a task is now being tracked — clear the reminder
        } else {
          setActiveWebTask('No active web task')
          activeWebTaskRef.current = 'No active web task'
          activeWebTaskIdRef.current = null
          activeTimeSessionIdRef.current = null
        }
        // New/changed task session → allow the next idle gap to be flagged afresh
        if (activeTimeSessionIdRef.current !== prevTsId) {
          timerIdleFlaggedRef.current = false
        }
      } catch (err) {
        console.error('Error fetching web task:', err)
      }
    }

    checkWebTask()
    webTaskIntervalRef.current = setInterval(checkWebTask, 15000) // Poll every 15 seconds
  }

  const startHeartbeat = () => {
    if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current)

    const triggerHeartbeat = async () => {
      if (!activeSession || !deviceInfo) return

      // Keep the active web task timer alive from the DESKTOP, independent of the
      // editor's browser. This is the core of Phase 2: a closed tab or dropped
      // connection can no longer stop the task timer or lose time.
      const tsId = activeTimeSessionIdRef.current
      if (tsId) {
        const nowIso = new Date().toISOString()
        try {
          if (!navigator.onLine && window.electronAPI) {
            await window.electronAPI.enqueueSyncItem({
              type: 'timer_heartbeat',
              payload_json: { session_id: tsId, at: nowIso },
              idempotency_key: crypto.randomUUID()
            })
          } else {
            await supabase.rpc('desktop_timer_heartbeat', { p_session_id: tsId, p_at: nowIso })
          }
        } catch (e) {
          console.error('Timer heartbeat failed:', e)
        }
      }

      try {
        const currentPermissions = await refreshPermissions()

        // Phase 4D: Process sleep gaps
        if (window.electronAPI) {
          const gaps = await window.electronAPI.getSleepGaps()
          if (gaps && gaps.length > 0) {
            let totalOffline = 0
            gaps.forEach((g: any) => totalOffline += g.durationMinutes)
            
            // Mark session as needing review
            if (navigator.onLine) {
              await supabase.from('attendance_sessions').update({
                needs_review: true,
                review_reason: 'Possible sleep/offline gap detected',
                offline_minutes: totalOffline
              }).eq('id', activeSession.id)
            } else {
              // We could enqueue this update, but simply letting it be handled offline is tricky.
              // We'll queue a custom item or just let the offline missing heartbeat flag it.
            }
          }
        }

        if (!navigator.onLine) {
          setHeartbeatFailed(false)
          setLastSyncTime('Offline Mode')
          return
        }

        // Call secure database RPC for heartbeat
        const { error } = await supabase.rpc('desktop_heartbeat', {
          p_session_id: activeSession.id,
          p_fingerprint: deviceInfo.fingerprint,
          p_screen_status: currentPermissions.screen,
          p_accessibility_status: currentPermissions.accessibility
        })

        if (error) throw error

        setHeartbeatFailed(false)
        setLastSyncTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
        console.log('Desktop heartbeat sent successfully.')
      } catch (err) {
        console.error('Heartbeat failure:', err)
        setHeartbeatFailed(true)
      }
    }

    triggerHeartbeat()
    heartbeatIntervalRef.current = setInterval(triggerHeartbeat, 60000) // Run every 60 seconds
  }

  const startScreenshotLoop = () => {
    if (screenshotTimeoutRef.current) clearTimeout(screenshotTimeoutRef.current)

    const scheduleNext = () => {
      const minMins = 5
      const maxMins = 10
      const delayMins = Math.random() * (maxMins - minMins) + minMins
      const delayMs = Math.round(delayMins * 60 * 1000)
      console.log(`[Screenshot Scheduler] Next capture in ${delayMins.toFixed(2)} minutes (${delayMs} ms)`)

      screenshotTimeoutRef.current = setTimeout(async () => {
        await captureAndUploadScreenshot()
        scheduleNext()
      }, delayMs)
    }

    scheduleNext()
  }

  const captureAndUploadScreenshot = async () => {
    const currActiveSession = activeSessionRef.current
    const currSession = sessionRef.current
    if (!currActiveSession || !currSession?.user?.id) {
      console.log('Skipping screenshot capture: No active session or user logged in.')
      return
    }

    try {
      // Refresh permissions
      const p = await refreshPermissions()
      if (p.screen !== 'granted') {
        console.warn('Skipping screenshot capture: Screen permission is not granted (status:', p.screen, ')')
        return
      }

      // 1. Fetch active web task (if any)
      let taskId: string | null = null
      let timeSessionId: string | null = null

      try {
        const { data: webTask, error: webTaskError } = await supabase
          .from('time_sessions')
          .select('id, task_id')
          .eq('user_id', currSession.user.id)
          .eq('status', 'active')
          .maybeSingle()

        if (!webTaskError && webTask) {
          taskId = webTask.task_id
          timeSessionId = webTask.id
        }
      } catch (e) {
        console.error('Error fetching active web task for screenshot:', e)
      }

      // 2. Capture screenshot via IPC
      if (!window.electronAPI || !window.electronAPI.captureScreen) {
        console.warn('Electron captureScreen API not available')
        return
      }

      const captureResult = await window.electronAPI.captureScreen()
      if (!captureResult.success || !captureResult.buffer) {
        console.warn('Screen capture returned success=false:', captureResult.error)
        return
      }

      // 3. Upload to private bucket 'desktop-screenshots'
      const timestamp = Date.now()
      const storagePath = `${currSession.user.id}/${currActiveSession.id}_${timestamp}.jpg`
      const idempotencyKey = crypto.randomUUID()
      const metadata = {
        user_id: currSession.user.id,
        session_id: currActiveSession.id,
        storage_path: storagePath,
        task_id: taskId,
        time_session_id: timeSessionId,
        idempotency_key: idempotencyKey
      }

      // Phase 4D: Handle Offline Screenshot
      if (!navigator.onLine && window.electronAPI) {
        const saveRes = await window.electronAPI.saveTempScreenshot(captureResult.buffer)
        if (saveRes.success) {
          await window.electronAPI.enqueueSyncItem({ 
            type: 'screenshot', 
            file_path: saveRes.filePath, 
            payload_json: metadata, 
            idempotency_key: idempotencyKey 
          })
          console.log('Offline: Screenshot queued locally.')
        }
        return
      }

      const { error: uploadError } = await supabase.storage
        .from('desktop-screenshots')
        .upload(storagePath, captureResult.buffer, {
          contentType: 'image/jpeg',
          upsert: true
        })

      if (uploadError) {
        // Fallback to queue if upload fails despite being online
        if (window.electronAPI) {
          const saveRes = await window.electronAPI.saveTempScreenshot(captureResult.buffer)
          if (saveRes.success) {
            await window.electronAPI.enqueueSyncItem({ 
              type: 'screenshot', 
              file_path: saveRes.filePath, 
              payload_json: metadata, 
              idempotency_key: idempotencyKey 
            })
            console.log('Upload failed: Screenshot queued locally.')
          }
        }
        return
      }

      // 4. Insert metadata row into public.screenshots table
      const { error: dbError } = await supabase
        .from('screenshots')
        .insert(metadata)

      if (dbError) {
        if (dbError.code !== '23505') console.error('Screenshot metadata insert failed:', dbError)
      }

      console.log('Screenshot successfully uploaded and registered in database:', storagePath)
    } catch (err) {
      console.error('Error in captureAndUploadScreenshot:', err)
    }
  }

  const startActivityTrackingLoop = async () => {
    if (activityTrackerIntervalRef.current) clearInterval(activityTrackerIntervalRef.current)

    // Check if tracking is enabled for this profile
    const prof = profileRef.current
    if (!prof || !prof.activity_tracking_enabled) {
      setActivityStatus('Disabled')
      if (window.electronAPI) window.electronAPI.setActivityTracking(false)
      return
    }

    setActivityStatus('Active')
    if (window.electronAPI) window.electronAPI.setActivityTracking(true)

    const runCheck = async () => {
      const currActiveSession = activeSessionRef.current
      const currSession = sessionRef.current
      if (!currActiveSession || !currSession?.user?.id) return

      try {
        const stats = await window.electronAPI?.getActivityStats()
        if (!stats) return
        
        // Calculate active seconds logic
        const totalInputs = stats.keyboardCount + stats.mouseCount + stats.mouseClickCount
        
        // Simple logic for beta: 
        // We poll every 60 seconds. 
        // If there is ANY input in this minute, we count it as 60 active seconds (or proportionally).
        // Let's say if totalInputs > 0, active_seconds = 60, else 0.
        const active_seconds = totalInputs > 0 ? 60 : 0
        const idle_seconds = totalInputs > 0 ? 0 : 60
        const activity_percentage = Math.round((active_seconds / 60) * 100)

        setActivePercentage(activity_percentage)

        if (totalInputs === 0) {
          idleMinutesRef.current += 1
          if (idleMinutesRef.current >= 5) {
            setActivityStatus('Idle')
          }
          // Flag a long idle gap on the active task timer ONCE per idle stretch
          // (never deducts time — admin reviews). Offline-buffered.
          const tsId = activeTimeSessionIdRef.current
          // Not while on a declared break — that idleness is expected, not suspicious.
          if (tsId && idleMinutesRef.current >= TIMER_IDLE_FLAG_MINUTES && !timerIdleFlaggedRef.current && !activeBreakRef.current) {
            timerIdleFlaggedRef.current = true
            const reason = `Idle ${idleMinutesRef.current}m during active timer — verify work time`
            try {
              if (!navigator.onLine && window.electronAPI) {
                await window.electronAPI.enqueueSyncItem({
                  type: 'timer_flag',
                  payload_json: { session_id: tsId, reason },
                  idempotency_key: crypto.randomUUID()
                })
              } else {
                await supabase.rpc('desktop_timer_flag', { p_session_id: tsId, p_reason: reason })
              }
            } catch (e) {
              console.error('Timer idle flag failed:', e)
            }
          }

          // Auto clock-out after 1h of no input — capped at when activity stopped,
          // so a forgotten clock-out can never inflate attendance. Fires once.
          // Skipped while a break is declared — handleBreakLimit owns the wrap-up
          // there (credit 30m, then clock out), so the two can't both fire.
          if (idleMinutesRef.current >= ATTENDANCE_IDLE_CLOCKOUT_MINUTES && !idleClockedOutRef.current && navigator.onLine && !activeBreakRef.current) {
            idleClockedOutRef.current = true
            try {
              // Stop any running task timer first (consistent with manual clock-out).
              if (tsId) {
                try { await supabase.rpc('desktop_timer_stop', { p_session_id: tsId, p_end_time: new Date(Date.now() - idleMinutesRef.current * 60000).toISOString() }) } catch {}
                activeTimeSessionIdRef.current = null
              }
              const { data: res } = await supabase.rpc('desktop_idle_clock_out', {
                p_session_id: currActiveSession.id,
                p_idle_minutes: idleMinutesRef.current,
              })
              if (res?.ok) {
                const at = new Date(res.clock_out).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
                setActiveSession(null)
                stopAllTrackers()
                await fetchTodaySessions()
                const msg = `You were auto clocked out at ${at} after 1 hour of inactivity. Clock back in when you resume.`
                setSyncError('')
                try { if ('Notification' in window && Notification.permission === 'granted') new Notification('vTrack — Auto clocked out', { body: msg }) } catch {}
                alert(msg)
              }
            } catch (e) {
              console.error('Idle auto clock-out failed:', e)
              idleClockedOutRef.current = false // allow retry next minute
            }
          }
        } else {
          idleMinutesRef.current = 0
          timerIdleFlaggedRef.current = false // activity resumed — allow flagging the next gap
          idleClockedOutRef.current = false
          setActivityStatus('Active')

          // Untracked-work watchdog: real input but NO task timer running.
          if (!activeTimeSessionIdRef.current) {
            untrackedActiveMinRef.current += 1
            if (untrackedActiveMinRef.current >= UNTRACKED_WORK_MINUTES) {
              if (navigator.onLine) {
                try {
                  // Pass the streak length so the session is BACKFILLED to when the
                  // untracked work began (capped server-side) — no minutes lost.
                  const { data: resume } = await supabase.rpc('desktop_timer_resume', {
                    p_untracked_minutes: untrackedActiveMinRef.current,
                  })
                  if (resume?.resumed && resume.id) {
                    // Same safe rule as clock-in: only an already-In-Progress task resumes.
                    activeTimeSessionIdRef.current = resume.id
                    if (resume.task_id) activeWebTaskIdRef.current = resume.task_id
                    if (resume.title) {
                      setActiveWebTask(resume.title)
                      activeWebTaskRef.current = resume.title
                    }
                    timerIdleFlaggedRef.current = false
                    untrackedActiveMinRef.current = 0
                    setClockInNudge(`Timer auto-resumed on "${resume.title || 'your task'}" — your untracked minutes were credited.`)
                  } else if (resume?.already_active) {
                    untrackedActiveMinRef.current = 0
                  } else {
                    // No in-progress task to resume — keep nudging, retry in 5 min.
                    setClockInNudge('You appear to be working with no task timer — start your task in vOps so this time is tracked.')
                    untrackedActiveMinRef.current = UNTRACKED_WORK_MINUTES - 5
                  }
                } catch (e) {
                  console.error('Untracked-work auto-resume failed:', e)
                  untrackedActiveMinRef.current = UNTRACKED_WORK_MINUTES - 5
                }
              } else {
                // Offline: can't safely resume — nudge and retry once back online.
                setClockInNudge('You appear to be working with no task timer — start your task in vOps so this time is tracked.')
                untrackedActiveMinRef.current = UNTRACKED_WORK_MINUTES - 5
              }
            }
          } else {
            untrackedActiveMinRef.current = 0
          }
        }

        const now = new Date()
        const oneMinuteAgo = new Date(now.getTime() - 60000)
        
        const logData = {
          user_id: currSession.user.id,
          device_id: currActiveSession.device_id || null,
          attendance_session_id: currActiveSession.id,
          task_id: activeWebTaskIdRef.current,
          time_session_id: activeTimeSessionIdRef.current,
          captured_at: now.toISOString(),
          interval_start: oneMinuteAgo.toISOString(),
          interval_end: now.toISOString(),
          keyboard_count: stats.keyboardCount,
          mouse_count: stats.mouseCount,
          mouse_click_count: stats.mouseClickCount,
          idle_seconds,
          active_seconds,
          activity_percentage,
          active_app: stats.activeApp,
          active_window_title: stats.activeWindowTitle,
          idempotency_key: crypto.randomUUID()
        }

        // Phase 4D: Handle offline logs
        if (!navigator.onLine && window.electronAPI) {
          await window.electronAPI.enqueueSyncItem({ 
            type: 'activity_log', 
            payload_json: logData, 
            idempotency_key: logData.idempotency_key 
          })
          return
        }

        const { error } = await supabase
          .from('activity_logs')
          .insert(logData)

        if (error) {
          if (error.code !== '23505' && window.electronAPI) {
            // Queue if insert fails (network error, timeout, etc)
            await window.electronAPI.enqueueSyncItem({ 
              type: 'activity_log', 
              payload_json: logData, 
              idempotency_key: logData.idempotency_key 
            })
          }
        }
      } catch (err) {
        console.error('Activity tracker error:', err)
      }
    }

    // Run immediately so the first minute of work is captured, then every 60s thereafter
    runCheck()
    activityTrackerIntervalRef.current = setInterval(runCheck, 60000)
  }

  const stopAllTrackers = () => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current)
      heartbeatIntervalRef.current = null
    }
    if (clockTimerIntervalRef.current) {
      clearInterval(clockTimerIntervalRef.current)
      clockTimerIntervalRef.current = null
    }
    if (webTaskIntervalRef.current) {
      clearInterval(webTaskIntervalRef.current)
      webTaskIntervalRef.current = null
    }
    if (screenshotTimeoutRef.current) {
      clearTimeout(screenshotTimeoutRef.current)
      screenshotTimeoutRef.current = null
    }
    if (activityTrackerIntervalRef.current) {
      clearInterval(activityTrackerIntervalRef.current)
      activityTrackerIntervalRef.current = null
    }
    setTimerStr('00:00:00')
    setActiveWebTask('No active web task')
    setActivityStatus('Disabled')
    setActivePercentage(0)
    idleMinutesRef.current = 0
    if (window.electronAPI && window.electronAPI.setActivityTracking) {
      window.electronAPI.setActivityTracking(false)
    }
  }

  // 7. Render Layouts
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 text-slate-900">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw className="h-10 w-10 text-blue-600 animate-spin" />
          <p className="text-[13px] font-medium tracking-wide text-slate-500">Loading vTrack...</p>
        </div>
      </div>
    )
  }

  // A. First-run Consent Screen
  if (session && !consentGranted) {
    return (
      <div className="flex flex-col h-screen bg-slate-50 text-slate-900 p-6 justify-between select-none">
        <div className="space-y-6">
          <div className="flex items-center gap-3 text-blue-400">
            <Fingerprint className="h-8 w-8" />
            <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">vTrack Consent</h1>
          </div>
          <p className="text-[14px] text-slate-500 leading-relaxed font-light">
            Vyral Operations System uses this desktop companion to securely record attendance and monitor focus sessions.
          </p>

          <div className="space-y-4 bg-white backdrop-blur-xl p-5 rounded-2xl border border-slate-200 text-[13px] text-slate-600 font-light shadow-sm">
            <div className="flex gap-3">
              <span className="text-emerald-400 font-bold">✓</span>
              <span><strong className="text-slate-900 font-medium">Attendance Session:</strong> Logs your Clock In / Out timestamps.</span>
            </div>
            <div className="flex gap-3">
              <span className="text-emerald-400 font-bold">✓</span>
              <span><strong className="text-slate-900 font-medium">Background Heartbeat:</strong> Updates your status every 60 seconds.</span>
            </div>
            <div className="flex gap-3">
              <span className="text-emerald-400 font-bold">✓</span>
              <span><strong className="text-slate-900 font-medium">Keystrokes:</strong> Key counts are recorded for activity metrics, but actual key content is <strong className="text-rose-400 font-medium">never</strong> logged.</span>
            </div>
            <div className="flex gap-3">
              <span className="text-emerald-400 font-bold">✓</span>
              <span><strong className="text-slate-900 font-medium">Zero Tracking Out-of-Hours:</strong> All tracking completely terminates when you Clock Out.</span>
            </div>
          </div>
        </div>

        <button 
          onClick={handleGrantConsent} 
          className="w-full h-12 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-[14px] font-medium active:scale-[0.98] transition-all shadow-sm shadow-blue-500/20"
        >
          I Consent & Agree
        </button>
      </div>
    )
  }

  // B. Login Screen
  if (!session) {
    return (
      <div className="flex flex-col h-screen justify-center px-6 py-12 bg-slate-50 text-slate-900 select-none">
        <div className="sm:mx-auto sm:w-full sm:max-w-sm space-y-8">
          <div className="flex flex-col items-center">
            <div className="h-16 w-16 rounded-2xl bg-white border border-slate-200 p-[1px] shadow-sm shadow-blue-500/30">
              <div className="h-full w-full bg-white rounded-2xl flex items-center justify-center">
                <Fingerprint className="h-8 w-8 text-blue-400" />
              </div>
            </div>
            <h2 className="mt-6 text-center text-[24px] font-semibold tracking-tight text-slate-900">
              vTrack Login
            </h2>
            <p className="text-[14px] text-slate-500 mt-2 font-light">Sign in with your vOps credentials</p>
          </div>

          <form className="space-y-5" onSubmit={handleLogin}>
            {authError && (
              <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl flex gap-3 items-start text-[13px] text-rose-400 backdrop-blur-md">
                <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5 text-rose-500" />
                <span className="font-medium">{authError}</span>
              </div>
            )}

            <div className="space-y-3">
              <input
                type="email"
                required
                placeholder="Email Address"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full h-12 px-4 rounded-xl border border-slate-200 bg-white backdrop-blur-md text-[14px] text-slate-900 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 placeholder:text-slate-500 transition-all font-light"
              />
              <input
                type="password"
                required
                placeholder="Password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full h-12 px-4 rounded-xl border border-slate-200 bg-white backdrop-blur-md text-[14px] text-slate-900 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 placeholder:text-slate-500 transition-all font-light"
              />
            </div>

            <button
              type="submit"
              className="w-full h-12 bg-white text-white rounded-xl text-[14px] font-semibold hover:bg-slate-200 active:scale-[0.98] transition-all shadow-sm"
            >
              Sign In
            </button>
          </form>
        </div>
      </div>
    )
  }

  // C. Stale Recovery Prompt Screen
  if (recoverySession) {
    return (
      <div className="flex flex-col h-screen bg-slate-50 text-slate-900 p-6 justify-between select-none">
        <div className="space-y-5 text-center my-auto">
          <div className="h-16 w-16 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-500 mx-auto shadow-sm shadow-amber-500/10">
            <Clock className="h-8 w-8" />
          </div>
          <h2 className="text-[20px] font-semibold text-slate-900 tracking-tight">Previous session needs review</h2>
          <p className="text-[13px] text-slate-500 leading-relaxed px-4 font-light">
            Your last attendance session is still active, but the heartbeat was missed. Choose how you want to continue.
          </p>
          <div className="bg-white backdrop-blur-md p-4 rounded-xl border border-slate-200 text-left text-[12px] text-slate-600 space-y-2 max-w-sm mx-auto shadow-xl">
            <p><strong className="text-slate-900 font-medium">Clocked In:</strong> {new Date(recoverySession.clock_in).toLocaleString()}</p>
            <p><strong className="text-slate-900 font-medium">Last Heartbeat:</strong> {new Date(recoverySession.updated_at).toLocaleString()}</p>
          </div>
          {syncError && (
            <p className="text-[12px] text-rose-400 font-medium bg-rose-500/10 border border-rose-500/20 rounded-lg p-3 max-w-sm mx-auto">
              {syncError}
            </p>
          )}
        </div>

        <div className="space-y-3">
          <button 
            onClick={() => handleResolveRecovery('continue')} 
            disabled={syncing}
            className="w-full h-12 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-[14px] font-medium disabled:opacity-50 transition-all shadow-sm shadow-blue-500/20 active:scale-[0.98]"
          >
            Continue Session
          </button>
          <button 
            onClick={() => handleResolveRecovery('lastseen')} 
            disabled={syncing}
            className="w-full h-12 bg-white border border-slate-200 text-slate-600 hover:bg-white/10 rounded-xl text-[14px] font-medium disabled:opacity-50 transition-all shadow-sm active:scale-[0.98]"
          >
            Clock Out at Last Seen
          </button>
          <button 
            onClick={() => handleResolveRecovery('now')} 
            disabled={syncing}
            className="w-full h-12 bg-white border border-slate-200 text-slate-600 hover:bg-white/10 rounded-xl text-[14px] font-medium disabled:opacity-50 transition-all shadow-sm active:scale-[0.98]"
          >
            Clock Out Now
          </button>
        </div>
      </div>
    )
  }

  // D. Main Tracker Dashboard View
  const isClockedIn = activeSession !== null

  // Calculate today's total completed minutes
  const completedMinutesToday = todaySessions
    .filter(s => s.status === 'completed' && s.total_minutes)
    .reduce((sum, s) => sum + (s.total_minutes || 0), 0)

  // Format total time including live session
  const formatTotalTime = (totalMins: number) => {
    const hrs = Math.floor(totalMins / 60)
    const mins = totalMins % 60
    if (hrs === 0) return `${mins}m`
    return `${hrs}h ${mins}m`
  }

  // Today's date string
  const todayDateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  })

  // Permissions compact check
  const allPermissionsGranted = permissions.screen === 'granted' && permissions.accessibility === 'granted'

  // ── Dial geometry ─────────────────────────────────────────────────────────
  const DIAL_R = 99
  const DIAL_C = 2 * Math.PI * DIAL_R
  const onBreak = !!activeBreak
  const elapsedMs = isClockedIn && activeSession ? Date.now() - new Date(activeSession.clock_in).getTime() : 0
  const breakMs = activeBreak ? breakElapsedMs(activeBreak) : 0
  // On a break the ring counts toward the 60-minute wrap-up; otherwise it shows
  // the shift filling up (8h reference).
  const dialPct = onBreak
    ? Math.min(1, breakMs / (BREAK_LIMIT_MINUTES * 60000))
    : Math.min(1, elapsedMs / (8 * 3600000))
  const dialLen = DIAL_C * dialPct
  const dialColor = onBreak ? '#E8890C' : '#0A0A0A'
  const ticks = <circle cx="119" cy="119" r={DIAL_R} fill="none" stroke="#fff" strokeWidth="15" strokeDasharray="2 6.171" />

  const initial = (profile?.name || profile?.email || 'U').charAt(0).toUpperCase()
  const totalTodayStr = formatTotalTime(completedMinutesToday + (isClockedIn && activeSession ? Math.floor(elapsedMs / 60000) : 0))

  return (
    <div className="flex flex-col h-screen bg-white text-[#0A0A0A] select-none">
      {/* ── Top bar ── */}
      <div className="flex items-center justify-between px-5 py-4 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="h-[26px] w-[26px] rounded-lg bg-[#0A0A0A] flex items-center justify-center">
            <Fingerprint className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-[13px] font-semibold tracking-tight">vTrack</span>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="h-[27px] w-[27px] rounded-full bg-[#FAFAFA] border border-[#EAEAEA] flex items-center justify-center text-[11px] font-semibold text-[#525252]" title={profile?.email}>
            {initial}
          </div>
          <button onClick={handleLogout} title="Log out" className="text-[#B4B4B4] hover:text-[#0A0A0A] transition-colors">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto px-6 flex flex-col">
        <div className="flex items-baseline justify-between pb-1">
          <span className="text-[10px] font-semibold tracking-[.14em] uppercase text-[#B4B4B4]">Your day</span>
          <span className="text-[11.5px] text-[#B4B4B4]">{todayDateStr}</span>
        </div>

        {/* Dial */}
        <div className="relative w-[238px] h-[238px] mx-auto mt-3.5">
          <svg width="238" height="238" viewBox="0 0 238 238" style={{ transform: 'rotate(-90deg)' }}>
            <defs><mask id="dialTicks">{ticks}</mask></defs>
            <circle cx="119" cy="119" r={DIAL_R} fill="none" stroke="#E4E4E4" strokeWidth="15" mask="url(#dialTicks)" />
            {dialLen > 0 && (
              <circle cx="119" cy="119" r={DIAL_R} fill="none" stroke={dialColor} strokeWidth="15" mask="url(#dialTicks)"
                      strokeDasharray={`${dialLen.toFixed(1)} ${(DIAL_C - dialLen).toFixed(1)}`} />
            )}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className={`text-[9.5px] font-semibold tracking-[.16em] uppercase mb-1.5 ${onBreak ? 'text-[#E8890C]' : 'text-[#B4B4B4]'}`}>
              {onBreak ? (breakNudged ? 'Still on break?' : 'On a break') : isClockedIn ? 'Elapsed' : 'Not started'}
            </div>
            <div className={`text-[46px] font-[250] tracking-[-.035em] tabular-nums leading-none ${isClockedIn ? 'text-[#0A0A0A]' : 'text-[#B4B4B4]'}`}>
              {onBreak ? breakStr : timerStr}
            </div>
            <div className="text-[11.5px] text-[#8A8A8A] tabular-nums mt-2.5">
              {onBreak
                ? `Task time still running · ${timerStr}`
                : isClockedIn ? `${totalTodayStr} today` : `${totalTodayStr} logged today`}
            </div>
          </div>
        </div>

        {/* Status */}
        <div className="flex justify-center mt-4 mb-4">
          <span className="inline-flex items-center gap-[7px] text-[11.5px] font-medium text-[#525252]">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: onBreak ? '#E8890C' : isClockedIn ? '#0FA968' : '#B4B4B4' }} />
            {onBreak ? 'Break' : isClockedIn ? 'Tracking' : 'Ready when you are'}
          </span>
        </div>

        {/* Working on */}
        <div className="flex items-center justify-between py-3 border-t border-b border-[#F2F2F2]">
          <div className="min-w-0">
            <div className="text-[9.5px] font-semibold tracking-[.14em] uppercase text-[#B4B4B4] mb-[3px]">Working on</div>
            <div className={`text-[13.5px] font-medium tracking-[-.01em] truncate ${isClockedIn && activeWebTask !== 'No active web task' ? 'text-[#0A0A0A]' : 'text-[#B4B4B4]'}`}>
              {isClockedIn ? activeWebTask : 'Nothing yet'}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2.5 mt-4">
          {!isClockedIn ? (
            <button onClick={handleClockIn} disabled={syncing}
              className="flex-1 h-[46px] rounded-xl bg-[#0A0A0A] text-white text-[13.5px] font-medium disabled:opacity-40 active:scale-[.99] transition-all">
              Clock in
            </button>
          ) : onBreak ? (
            <>
              <button onClick={() => endBreak('manual')} disabled={breakBusy}
                className="flex-[1.3] h-[46px] rounded-xl bg-[#0A0A0A] text-white text-[13.5px] font-medium disabled:opacity-40 active:scale-[.99] transition-all">
                I&apos;m back
              </button>
              <button onClick={handleClockOut} disabled={syncing}
                className="flex-1 h-[46px] rounded-xl bg-white border border-[#EAEAEA] text-[13.5px] font-medium disabled:opacity-40 hover:bg-[#FAFAFA] transition-colors">
                Clock out
              </button>
            </>
          ) : (
            <>
              <button onClick={startBreak} disabled={breakBusy}
                className="flex-1 h-[46px] rounded-xl bg-white border border-[#EAEAEA] text-[13.5px] font-medium disabled:opacity-40 hover:bg-[#FAFAFA] transition-colors">
                Take a break
              </button>
              <button onClick={handleClockOut} disabled={syncing}
                className="flex-1 h-[46px] rounded-xl bg-[#0A0A0A] text-white text-[13.5px] font-medium disabled:opacity-40 active:scale-[.99] transition-all">
                Clock out
              </button>
            </>
          )}
        </div>

        {/* Meta line */}
        <div className="mt-4 text-[11.5px] text-[#8A8A8A]">
          <button onClick={() => setShowSessionHistory(!showSessionHistory)} className="hover:text-[#0A0A0A] transition-colors">
            <b className="text-[#0A0A0A] font-semibold tabular-nums">{todaySessions.length}</b> sessions
          </button>
          {profile?.activity_tracking_enabled && activityStatus !== 'Disabled' && (
            <><span className="text-[#B4B4B4] mx-[7px]">·</span><b className="text-[#0A0A0A] font-semibold tabular-nums">{activePercentage}%</b> activity</>
          )}
          {breaksToday.count > 0 && (
            <><span className="text-[#B4B4B4] mx-[7px]">·</span><b className="text-[#0A0A0A] font-semibold tabular-nums">{breaksToday.count}</b> {breaksToday.count === 1 ? 'break' : 'breaks'}, {breaksToday.minutes}m</>
          )}
          {!allPermissionsGranted && (
            <><span className="text-[#B4B4B4] mx-[7px]">·</span><span className="text-[#E8890C]">permissions needed</span></>
          )}
        </div>

        {/* Session history */}
        {showSessionHistory && todaySessions.length > 0 && (
          <div className="mt-3 space-y-1 pb-1">
            {todaySessions.map(s => {
              const fmt = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              return (
                <div key={s.id} className="flex items-center justify-between text-[11.5px] tabular-nums">
                  <span className="text-[#8A8A8A]">
                    {fmt(new Date(s.clock_in))} → {s.clock_out ? fmt(new Date(s.clock_out)) : <span className="text-[#0FA968]">now</span>}
                  </span>
                  <span className="text-[#525252]">{s.total_minutes ? formatTotalTime(s.total_minutes) : (s.status === 'active' ? 'running' : '–')}</span>
                </div>
              )
            })}
          </div>
        )}

        {/* ── Banners ── */}
        {syncError && (
          <div className="mt-4 px-3.5 py-3 rounded-xl bg-[#FFF5F5] border border-[#F5D2D2] text-[12px] leading-relaxed text-[#9B2C2C]">
            {syncError}
            {syncError.includes('Clock Out') && <button onClick={handleClockOut} className="ml-2 font-semibold underline">Retry</button>}
            {syncError.includes('Clock In') && <button onClick={handleClockIn} className="ml-2 font-semibold underline">Retry</button>}
          </div>
        )}

        {onBreak && (
          breakNudged ? (
            <div className="mt-4 px-3.5 py-3 rounded-xl bg-[#FFFBF4] border border-[#F6E4C8] text-[12px] leading-relaxed text-[#525252]">
              Hey — you&apos;ve been away about <b className="text-[#0A0A0A] font-semibold">50 minutes</b>. No rush, just tap <b className="text-[#0A0A0A] font-semibold">I&apos;m back</b> when you return. If we don&apos;t hear from you by 60 min we&apos;ll clock you out so your hours stay accurate.
            </div>
          ) : (
            <div className="mt-4 px-3.5 py-3 rounded-xl bg-[#FAFAFA] border border-[#EAEAEA] text-[12px] leading-relaxed text-[#525252]">
              Take your time — your task and attendance clocks keep running while you&apos;re away.
            </div>
          )
        )}

        {isClockedIn && !onBreak && clockInNudge && (
          <div className="mt-4 px-3.5 py-3 rounded-xl bg-[#FFFBF4] border border-[#F6E4C8] text-[12px] leading-relaxed text-[#525252]">
            {clockInNudge}
          </div>
        )}

        {!allPermissionsGranted && (
          <div className="mt-4 px-3.5 py-3 rounded-xl bg-[#FAFAFA] border border-[#EAEAEA] text-[12px] text-[#525252] space-y-1.5">
            {permissions.screen !== 'granted' && (
              <div className="flex items-center justify-between">
                <span>Screen recording · <span className="capitalize text-[#8A8A8A]">{permissions.screen}</span></span>
                <button onClick={() => requestPermission('screen')} className="font-semibold text-[#0A0A0A] underline">Allow</button>
              </div>
            )}
            {permissions.accessibility !== 'granted' && (
              <div className="flex items-center justify-between">
                <span>Accessibility · <span className="capitalize text-[#8A8A8A]">{permissions.accessibility}</span></span>
                <button onClick={() => requestPermission('accessibility')} className="font-semibold text-[#0A0A0A] underline">Allow</button>
              </div>
            )}
          </div>
        )}

        {(queueStats.pendingCount > 0 || queueStats.failedCount > 0 || !isOnline) && (
          <div className="mt-4 px-3.5 py-3 rounded-xl bg-[#FAFAFA] border border-[#EAEAEA] text-[12px] text-[#525252] flex items-center justify-between">
            <span className="flex items-center gap-2">
              <RefreshCw className={`h-3.5 w-3.5 ${
                !isOnline ? 'text-[#B4B4B4]'
                : queueStats.pendingCount > 0 ? 'text-[#0A0A0A] animate-spin'
                : queueStats.failedCount > 0 ? 'text-[#E8890C]'
                : 'text-[#0FA968]'}`} />
              {!isOnline
                ? 'Offline — saved on this device'
                : queueStats.pendingCount > 0
                  ? `Syncing ${queueStats.pendingCount}…`
                  : queueStats.failedCount > 0
                    ? `${queueStats.failedCount} ${queueStats.failedCount === 1 ? 'record' : 'records'} didn't reach the server`
                    : 'Synced'}
            </span>
            {queueStats.failedCount > 0 && isOnline && (
              <button onClick={async () => { if (window.electronAPI) { await window.electronAPI.forceSyncRetry(); startSyncManager() } }}
                className="font-semibold text-[#0A0A0A] underline">Retry {queueStats.failedCount}</button>
            )}
          </div>
        )}

        <div className="h-4 shrink-0" />
      </div>

      {/* ── Footer ── */}
      <div className="flex items-center justify-between px-6 py-3.5 border-t border-[#F2F2F2] text-[10.5px] text-[#B4B4B4] shrink-0">
        <span>
          {isClockedIn
            ? (heartbeatFailed ? <span className="text-[#E8890C]">Reconnecting…</span> : `Synced ${lastSyncTime || '—'}`)
            : ''}
        </span>
        {updaterStatus
          ? <span className="text-[#525252]">{updaterStatus}</span>
          : <button
              onClick={async () => { if (window.electronAPI?.checkForUpdates) { setUpdaterStatus('Checking…'); await window.electronAPI.checkForUpdates() } }}
              className="hover:text-[#0A0A0A] transition-colors" title="Check for updates">
              v{appVersion || '…'}
            </button>}
      </div>
    </div>
  )
}
