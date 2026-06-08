import { useState, useEffect, useRef } from 'react'
import { supabase } from './supabase'
import { 
  Fingerprint, 
  LogOut, 
  AlertTriangle, 
  User, 
  Clock, 
  ShieldCheck, 
  Play, 
  Square,
  RefreshCw,
  Calendar,
  ChevronDown,
  ChevronUp,
  History
} from 'lucide-react'

type Profile = {
  name: string
  email: string
  role: string
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
              if (!readResult.success) throw new Error(readResult.error || 'Failed to read local screenshot')
              
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
        .select('name, email, role, activity_tracking_enabled')
        .eq('id', userId)
        .single()

      if (error) throw error

      if (!['editor', 'manager'].includes(data.role)) {
        setAuthError('Access denied. Only editors and managers are authorized to use the desktop tracker.')
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
      if (err.message && (err.message.toLowerCase().includes('fetch') || err.message.toLowerCase().includes('network') || err.message.toLowerCase().includes('failed to connect'))) {
        errorMsg = 'Unable to connect to vOps server. Please check your internet connection.'
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
      setAuthError(err.message || 'Login failed. Please check credentials.')
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

  const handleClockOut = async () => {
    if (!activeSession) return
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
          if (tsId && idleMinutesRef.current >= TIMER_IDLE_FLAG_MINUTES && !timerIdleFlaggedRef.current) {
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
        } else {
          idleMinutesRef.current = 0
          timerIdleFlaggedRef.current = false // activity resumed — allow flagging the next gap
          setActivityStatus('Active')
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

  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-900 justify-between select-none">
      {/* Top Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-slate-50 shadow-sm shrink-0">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-white border border-slate-200 p-[1px] shadow-sm shadow-blue-500/20 flex items-center justify-center">
             <div className="h-full w-full bg-white rounded-lg flex items-center justify-center">
               <Fingerprint className="h-5 w-5 text-blue-400" />
             </div>
          </div>
          <div>
            <h1 className="text-[14px] font-semibold text-slate-900 tracking-tight">vTrack</h1>
            <p className="text-[10px] text-slate-500 font-light">Vyral Operations System</p>
          </div>
        </div>
        <button 
          onClick={handleLogout} 
          className="h-8 px-3 rounded-lg border border-slate-200 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 hover:border-rose-500/20 flex items-center gap-1.5 text-[11px] font-medium transition-all"
        >
          <LogOut className="h-3.5 w-3.5" /> Logout
        </button>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
        {/* Editor Profile Details */}
        <div className="bg-white backdrop-blur-md p-3.5 rounded-2xl border border-slate-200 flex items-center gap-3 shadow-sm">
          <div className="h-10 w-10 rounded-full bg-slate-800 border border-slate-200 text-slate-500 flex items-center justify-center shrink-0 shadow-inner">
            <User className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-slate-900 truncate tracking-wide">{profile?.name}</p>
            <p className="text-[11px] text-slate-500 truncate font-light">{profile?.email}</p>
          </div>
        </div>

        {/* Sync errors block */}
        {syncError && (
          <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl text-[12px] text-rose-400 flex flex-col gap-2 backdrop-blur-md">
            <div className="flex gap-2 items-start">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span className="font-medium">{syncError}</span>
            </div>
            {syncError.includes('Clock Out') && (
              <button
                onClick={handleClockOut}
                disabled={syncing}
                className="self-start text-[11px] text-rose-300 font-semibold hover:text-rose-200 transition-colors"
              >
                Retry Clock Out
              </button>
            )}
            {syncError.includes('Clock In') && (
              <button
                onClick={handleClockIn}
                disabled={syncing}
                className="self-start text-[11px] text-rose-300 font-semibold hover:text-rose-200 transition-colors"
              >
                Retry Clock In
              </button>
            )}
          </div>
        )}

        {/* Today's Date */}
        <div className="flex items-center gap-2 px-1">
          <Calendar className="h-4 w-4 text-slate-500" />
          <p className="text-[12px] font-medium tracking-wide text-slate-500">{todayDateStr}</p>
        </div>

        {/* Large Timer Visualizer */}
        <div className="bg-white backdrop-blur-xl p-6 rounded-3xl border border-slate-200 text-center space-y-2 relative overflow-hidden shadow-sm">
          {isClockedIn && <div className="absolute -top-24 -left-24 w-48 h-48 bg-blue-500/20 rounded-full blur-3xl animate-pulse-slow"></div>}
          {isClockedIn && <div className="absolute -bottom-24 -right-24 w-48 h-48 bg-emerald-500/10 rounded-full blur-3xl animate-pulse-slow" style={{ animationDelay: '1s' }}></div>}
          
          <p className="text-[11px] font-medium uppercase tracking-widest text-slate-500 relative z-10">
            {isClockedIn ? 'Clocked In Duration' : 'Not Clocked In'}
          </p>
          <h2 className={`text-[40px] font-light font-mono tracking-tighter relative z-10 ${isClockedIn ? 'text-slate-900 drop-shadow-[0_0_15px_rgba(255,255,255,0.3)]' : 'text-slate-600'}`}>
            {timerStr}
          </h2>
          <div className="flex justify-center pt-2 relative z-10">
            {isClockedIn ? (
              <span className="flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider backdrop-blur-md shadow-[0_0_10px_rgba(16,185,129,0.2)]">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> Live Tracking
              </span>
            ) : (
              <span className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-500 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider">
                Offline
              </span>
            )}
          </div>
        </div>

        {/* Today's Total Time Card */}
        <div className="bg-white backdrop-blur-md p-4 rounded-2xl border border-slate-200 space-y-3 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-medium text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" /> Today's Total
            </p>
            <p className="text-[20px] font-light text-slate-900 font-mono tracking-tight">
              {formatTotalTime(completedMinutesToday + (isClockedIn ? Math.floor((Date.now() - new Date(activeSession!.clock_in).getTime()) / 60000) : 0))}
            </p>
          </div>
          {todaySessions.length > 0 && (
            <>
              <button
                onClick={() => setShowSessionHistory(!showSessionHistory)}
                className="flex items-center gap-1.5 text-[11px] text-blue-400 font-medium hover:text-blue-300 transition-colors"
              >
                <History className="h-3.5 w-3.5" />
                {showSessionHistory ? 'Hide' : 'Show'} Sessions ({todaySessions.length})
                {showSessionHistory ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              {showSessionHistory && (
                <div className="space-y-1.5 pt-2 border-t border-slate-200">
                  {todaySessions.map(s => {
                    const clockIn = new Date(s.clock_in)
                    const clockOut = s.clock_out ? new Date(s.clock_out) : null
                    const fmtTime = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    const duration = s.total_minutes ? formatTotalTime(s.total_minutes) : (s.status === 'active' ? 'running' : '–')
                    return (
                      <div key={s.id} className="flex items-center justify-between text-[11px] py-1">
                        <span className="text-slate-500 font-mono tracking-tight">
                          {fmtTime(clockIn)} → {clockOut ? fmtTime(clockOut) : <span className="text-emerald-400 font-medium drop-shadow-[0_0_8px_rgba(16,185,129,0.5)]">Now</span>}
                        </span>
                        <span className={`font-mono ${s.status === 'active' ? 'text-emerald-400 font-medium' : 'text-slate-600'}`}>
                          {duration}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
          {todaySessions.length === 0 && !isClockedIn && (
            <p className="text-[11px] text-slate-500 font-light">No sessions logged today yet.</p>
          )}
        </div>

        {/* Gentle reminder: clocked in but no task being tracked */}
        {isClockedIn && clockInNudge && (
          <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-2xl px-3.5 py-2.5">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p className="text-[11px] font-medium leading-snug">{clockInNudge}</p>
          </div>
        )}

        {/* Secondary Metrics Grid */}
        <div className="grid grid-cols-2 gap-3">
          {/* Active Web Task Section */}
          <div className="bg-white backdrop-blur-md p-3.5 rounded-2xl border border-slate-200 space-y-2 shadow-sm">
            <p className="text-[9px] font-medium text-slate-500 uppercase tracking-widest">Active Task</p>
            <div className="flex items-center gap-2">
              <div className={`h-2 w-2 rounded-full shrink-0 shadow-sm ${isClockedIn && activeWebTask !== 'No active web task' ? 'bg-blue-400 shadow-blue-400/50' : 'bg-slate-600'}`} />
              <p className="text-[12px] font-medium text-slate-900 truncate tracking-wide">
                {activeWebTask}
              </p>
            </div>
          </div>

          {/* Activity Tracking Status */}
          {profile?.activity_tracking_enabled && (
            <div className="bg-white backdrop-blur-md p-3.5 rounded-2xl border border-slate-200 space-y-2 shadow-sm">
              <p className="text-[9px] font-medium text-slate-500 uppercase tracking-widest">Activity</p>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <div className={`h-2 w-2 rounded-full shrink-0 shadow-sm ${
                    activityStatus === 'Active' ? 'bg-emerald-400 shadow-emerald-400/50' : 
                    activityStatus === 'Idle' ? 'bg-amber-400 shadow-amber-400/50' : 'bg-slate-600'
                  }`} />
                  <p className="text-[12px] font-medium text-slate-900 truncate tracking-wide">
                    {activityStatus === 'Disabled' ? 'Disabled' : activityStatus}
                  </p>
                </div>
                {activityStatus !== 'Disabled' && (
                  <div className="text-[10px] font-bold text-slate-500 font-mono">
                    {activePercentage}%
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Permissions & OS Checklist */}
        <div className="bg-white backdrop-blur-md p-4 rounded-2xl border border-slate-200 space-y-3 shadow-sm">
          <p className="text-[10px] font-medium text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
            <ShieldCheck className={`h-4 w-4 ${allPermissionsGranted ? 'text-emerald-400 drop-shadow-[0_0_8px_rgba(16,185,129,0.3)]' : 'text-amber-400'}`} /> Permissions
          </p>
          
          {allPermissionsGranted ? (
            <div className="flex items-center gap-2 text-[12px] text-emerald-400 font-medium">
              <span className="text-emerald-400 font-bold">✓</span> All permissions granted
            </div>
          ) : (
            <div className="space-y-2 text-[12px]">
              <div className="flex items-center justify-between py-1.5 border-b border-white/5">
                <span className="text-slate-600 font-light">Screen Capture</span>
                <div className="flex items-center gap-2">
                  <span className={`font-medium capitalize ${permissions.screen === 'granted' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {permissions.screen}
                  </span>
                  {permissions.screen !== 'granted' && (
                    <button 
                      onClick={() => requestPermission('screen')} 
                      className="text-[11px] text-blue-400 hover:text-blue-300 font-medium transition-colors"
                    >
                      Allow
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between py-1.5">
                <span className="text-slate-600 font-light">Accessibility</span>
                <div className="flex items-center gap-2">
                  <span className={`font-medium capitalize ${permissions.accessibility === 'granted' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {permissions.accessibility}
                  </span>
                  {permissions.accessibility !== 'granted' && (
                    <button 
                      onClick={() => requestPermission('accessibility')} 
                      className="text-[11px] text-blue-400 hover:text-blue-300 font-medium transition-colors"
                    >
                      Allow
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Clock In / Out Toggle Button & Footer */}
      <div className="p-5 bg-slate-50/80 backdrop-blur-xl border-t border-slate-200 shadow-[0_-10px_30px_rgba(0,0,0,0.5)] flex flex-col gap-4 shrink-0 z-20">
        
        {/* Phase 4D: Sync Manager UI */}
        {(queueStats.pendingCount > 0 || queueStats.failedCount > 0 || !isOnline) && (
          <div className="flex items-center justify-between bg-white backdrop-blur-md p-3 rounded-xl border border-slate-200 shadow-inner">
            <div className="flex items-center gap-2 text-[11px] text-slate-600 font-medium">
              <RefreshCw className={`h-4 w-4 ${!isOnline ? 'text-slate-500' : (queueStats.pendingCount > 0 ? 'text-blue-400 animate-spin' : 'text-emerald-400')}`} />
              <span>
                {!isOnline ? 'Offline: Data queued locally' : 
                 (queueStats.pendingCount > 0 ? `Syncing ${queueStats.pendingCount} items...` : 'Sync complete')}
              </span>
            </div>
            {queueStats.failedCount > 0 && isOnline && (
              <button 
                onClick={async () => {
                  if (window.electronAPI) {
                    await window.electronAPI.forceSyncRetry()
                    startSyncManager()
                  }
                }}
                className="text-[10px] text-slate-900 bg-rose-500/20 border border-rose-500/30 px-2.5 py-1.5 rounded-lg font-medium hover:bg-rose-500/40 transition-colors"
              >
                Retry {queueStats.failedCount} Failed
              </button>
            )}
          </div>
        )}

        <div className="flex gap-3">
          {isClockedIn ? (
            <button
              onClick={handleClockOut}
              disabled={syncing}
              className="flex-1 h-12 bg-rose-600 hover:bg-rose-500 text-slate-900 active:scale-[0.98] disabled:opacity-50 font-medium rounded-xl text-[14px] flex items-center justify-center gap-2 transition-all shadow-sm shadow-rose-600/20 border border-rose-500/50"
            >
              <Square className="h-4 w-4" /> Clock Out
            </button>
          ) : (
            <button
              onClick={handleClockIn}
              disabled={syncing}
              className="flex-1 h-12 bg-blue-600 hover:bg-blue-500 text-slate-900 active:scale-[0.98] disabled:opacity-50 font-medium rounded-xl text-[14px] flex items-center justify-center gap-2 transition-all shadow-sm shadow-blue-600/20 border border-blue-500/50"
            >
              <Play className="h-4 w-4 fill-white ml-0.5" /> Clock In
            </button>
          )}
        </div>

        {/* Footer info: Last Sync and Version */}
        <div className="flex justify-between items-center text-[10px] text-slate-500 font-light px-1 select-none tracking-wide">
          <div>
            {isClockedIn && (
              heartbeatFailed ? (
                <span className="text-rose-400 font-medium animate-pulse">Sync issue. Retrying...</span>
              ) : (
                <span>Last Sync: {lastSyncTime || 'Pending...'}</span>
              )
            )}
          </div>
          {/* App Version Info */}
          <div className="flex items-center gap-3">
            {updaterStatus 
              ? <span className={`text-[11px] font-medium animate-pulse ${updaterStatus.includes('error') || updaterStatus.includes('failed') ? 'text-rose-500' : 'text-blue-500'}`}>{updaterStatus}</span>
              : <button
                  onClick={async () => {
                    if (window.electronAPI?.checkForUpdates) {
                      setUpdaterStatus('Checking...')
                      await window.electronAPI.checkForUpdates()
                    }
                  }}
                  className="text-[11px] text-slate-400 hover:text-blue-500 transition-colors underline underline-offset-2"
                  title="Click to manually check for updates"
                >
                  vTrack v{appVersion || '...'}
                </button>
            }
          </div>
        </div>
      </div>
    </div>
  )
}
