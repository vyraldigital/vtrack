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
        
        setActiveSession(null)
        setRecoverySession(null)
        await fetchTodaySessions()
        return
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
        if (data && data.task) {
          setActiveWebTask((data.task as unknown as { title: string }).title)
          activeWebTaskRef.current = (data.task as unknown as { title: string }).title
          activeWebTaskIdRef.current = data.task_id
          activeTimeSessionIdRef.current = data.id
        } else {
          setActiveWebTask('No active web task')
          activeWebTaskRef.current = 'No active web task'
          activeWebTaskIdRef.current = null
          activeTimeSessionIdRef.current = null
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
        const stats = await window.electronAPI.getActivityStats()
        
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
        } else {
          idleMinutesRef.current = 0
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
      <div className="flex h-screen items-center justify-center bg-[#F7F8FC]">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="h-8 w-8 text-[#3B82F6] animate-spin" />
          <p className="text-[13px] font-semibold text-[#667085]">Loading tracker...</p>
        </div>
      </div>
    )
  }

  // A. First-run Consent Screen
  if (session && !consentGranted) {
    return (
      <div className="flex flex-col h-screen bg-white p-6 justify-between select-none">
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-[#3B82F6]">
            <Fingerprint className="h-7 w-7" />
            <h1 className="text-[20px] font-bold text-[#111827]">vOps Tracker Consent</h1>
          </div>
          <p className="text-[13px] text-[#667085] leading-relaxed">
            Vyral Operations System uses this desktop companion to record attendance and monitor focus sessions.
          </p>

          <div className="space-y-3 bg-[#F7F8FC] p-4 rounded-xl border border-[#E6E8EF] text-[12px] text-[#667085]">
            <div className="flex gap-2">
              <span className="text-[#16A34A] font-bold">✓</span>
              <span><strong>Attendance Session:</strong> Logs your Clock In / Out timestamps.</span>
            </div>
            <div className="flex gap-2">
              <span className="text-[#16A34A] font-bold">✓</span>
              <span><strong>Background Heartbeat:</strong> Updates your status every 60 seconds.</span>
            </div>
            <div className="flex gap-2">
              <span className="text-[#16A34A] font-bold">✓</span>
              <span><strong>Keystrokes:</strong> Key counts are recorded for activity metrics, but actual key content is <strong>never</strong> logged.</span>
            </div>
            <div className="flex gap-2">
              <span className="text-[#16A34A] font-bold">✓</span>
              <span><strong>Zero Tracking Out-of-Hours:</strong> All tracking schedule terminates completely when you Clock Out.</span>
            </div>
          </div>
        </div>

        <button 
          onClick={handleGrantConsent} 
          className="w-full h-11 bg-[#3B82F6] text-white rounded-xl text-[14px] font-semibold hover:bg-[#2563EB] active:scale-98 transition-all shadow-sm"
        >
          I Consent & Agree
        </button>
      </div>
    )
  }

  // B. Login Screen
  if (!session) {
    return (
      <div className="flex flex-col h-screen justify-center px-6 py-12 bg-[#F7F8FC]">
        <div className="sm:mx-auto sm:w-full sm:max-w-sm space-y-5">
          <div className="flex flex-col items-center">
            <div className="h-12 w-12 rounded-2xl bg-white border border-[#E6E8EF] flex items-center justify-center text-[#3B82F6] shadow-sm">
              <Fingerprint className="h-6 w-6" />
            </div>
            <h2 className="mt-4 text-center text-[20px] font-bold tracking-tight text-[#111827]">
              vOps Tracker Login
            </h2>
            <p className="text-[12px] text-[#667085] mt-1">Sign in with your vOps credentials</p>
          </div>

          <form className="space-y-4" onSubmit={handleLogin}>
            {authError && (
              <div className="p-3 bg-red-50 border border-red-100 rounded-xl flex gap-2 items-start text-[12px] text-red-600">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{authError}</span>
              </div>
            )}

            <div>
              <input
                type="email"
                required
                placeholder="Email Address"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full h-11 px-3.5 rounded-xl border border-[#E6E8EF] bg-white text-[13px] text-[#111827] focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/20 placeholder:text-[#98A2B3]"
              />
            </div>

            <div>
              <input
                type="password"
                required
                placeholder="Password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full h-11 px-3.5 rounded-xl border border-[#E6E8EF] bg-white text-[13px] text-[#111827] focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/20 placeholder:text-[#98A2B3]"
              />
            </div>

            <button
              type="submit"
              className="w-full h-11 bg-[#111827] text-white rounded-xl text-[13px] font-semibold hover:bg-black active:scale-98 transition-all shadow-sm"
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
      <div className="flex flex-col h-screen bg-[#F7F8FC] p-6 justify-between select-none">
        <div className="space-y-4 text-center my-auto">
          <div className="h-12 w-12 rounded-2xl bg-yellow-50 border border-yellow-100 flex items-center justify-center text-[#D97706] mx-auto shadow-sm">
            <Clock className="h-6 w-6" />
          </div>
          <h2 className="text-[18px] font-bold text-[#111827]">Previous session needs review</h2>
          <p className="text-[12px] text-[#667085] leading-relaxed px-2">
            Your last attendance session is still active, but the heartbeat was missed. Choose how you want to continue.
          </p>
          <div className="bg-white p-3.5 rounded-xl border border-[#E6E8EF] text-left text-[11px] text-[#667085] space-y-1.5 max-w-sm mx-auto">
            <p><strong>Clocked In:</strong> {new Date(recoverySession.clock_in).toLocaleString()}</p>
            <p><strong>Last Heartbeat:</strong> {new Date(recoverySession.updated_at).toLocaleString()}</p>
          </div>
          {syncError && (
            <p className="text-[11px] text-[#EF4444] font-medium bg-red-50 border border-red-100 rounded-lg p-2 max-w-sm mx-auto">
              {syncError}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <button 
            onClick={() => handleResolveRecovery('continue')} 
            disabled={syncing}
            className="w-full h-10 bg-[#3B82F6] text-white rounded-xl text-[13px] font-semibold hover:bg-[#2563EB] disabled:opacity-50 transition-all shadow-sm"
          >
            Continue Session
          </button>
          <button 
            onClick={() => handleResolveRecovery('lastseen')} 
            disabled={syncing}
            className="w-full h-10 bg-white border border-[#E6E8EF] text-[#667085] hover:bg-[#F7F8FC] rounded-xl text-[13px] font-semibold disabled:opacity-50 transition-all shadow-sm"
          >
            Clock Out at Last Seen
          </button>
          <button 
            onClick={() => handleResolveRecovery('now')} 
            disabled={syncing}
            className="w-full h-10 bg-white border border-[#E6E8EF] text-[#667085] hover:bg-[#F7F8FC] rounded-xl text-[13px] font-semibold disabled:opacity-50 transition-all shadow-sm"
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
    <div className="flex flex-col h-screen bg-[#F7F8FC] justify-between select-none">
      {/* Top Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[#E6E8EF] bg-white shadow-sm shrink-0">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-[#EEF4FF] text-[#3B82F6] flex items-center justify-center">
            <Fingerprint className="h-4.5 w-4.5" />
          </div>
          <div>
            <h1 className="text-[14px] font-bold text-[#111827]">vOps Tracker</h1>
            <p className="text-[9px] text-[#98A2B3]">Vyral Operations System</p>
          </div>
        </div>
        <button 
          onClick={handleLogout} 
          className="h-8 px-2.5 rounded-lg border border-[#E6E8EF] text-[#667085] hover:text-[#EF4444] hover:bg-red-50 flex items-center gap-1.5 text-[11px] font-semibold transition-all"
        >
          <LogOut className="h-3.5 w-3.5" /> Logout
        </button>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {/* Editor Profile Details */}
        <div className="bg-white p-3 rounded-xl border border-[#E6E8EF] flex items-center gap-3">
          <div className="h-9 w-9 rounded-full bg-[#F1F4FA] text-[#667085] flex items-center justify-center shrink-0">
            <User className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-[#111827] truncate">{profile?.name}</p>
            <p className="text-[10px] text-[#667085] truncate">{profile?.email}</p>
          </div>
        </div>

        {/* Sync errors block */}
        {syncError && (
          <div className="p-3 bg-red-50 border border-red-100 rounded-xl text-[11px] text-red-600 flex flex-col gap-2">
            <div className="flex gap-2 items-start">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{syncError}</span>
            </div>
            {syncError.includes('Clock Out') && (
              <button
                onClick={handleClockOut}
                disabled={syncing}
                className="self-start text-[10px] text-[#3B82F6] font-semibold hover:underline"
              >
                Retry Clock Out
              </button>
            )}
            {syncError.includes('Clock In') && (
              <button
                onClick={handleClockIn}
                disabled={syncing}
                className="self-start text-[10px] text-[#3B82F6] font-semibold hover:underline"
              >
                Retry Clock In
              </button>
            )}
          </div>
        )}

        {/* Today's Date */}
        <div className="flex items-center gap-2 px-1">
          <Calendar className="h-3.5 w-3.5 text-[#98A2B3]" />
          <p className="text-[11px] font-semibold text-[#667085]">{todayDateStr}</p>
        </div>

        {/* Large Timer Visualizer */}
        <div className="bg-white p-5 rounded-2xl border border-[#E6E8EF] text-center space-y-1">
          <p className="text-[11px] font-bold uppercase tracking-wider text-[#98A2B3]">
            {isClockedIn ? 'Clocked In Duration' : 'Not Clocked In'}
          </p>
          <h2 className={`text-[32px] font-bold font-mono tracking-tight ${isClockedIn ? 'text-[#111827]' : 'text-[#98A2B3]'}`}>
            {timerStr}
          </h2>
          <div className="flex justify-center pt-2">
            {isClockedIn ? (
              <span className="flex items-center gap-1 bg-[#DCFCE7] text-[#16A34A] px-2 py-0.5 rounded-full text-[10px] font-bold uppercase">
                <span className="h-1.5 w-1.5 rounded-full bg-[#16A34A] animate-pulse" /> Live Tracking
              </span>
            ) : (
              <span className="flex items-center gap-1 bg-[#F1F4FA] text-[#667085] px-2 py-0.5 rounded-full text-[10px] font-bold uppercase">
                Offline
              </span>
            )}
          </div>
        </div>

        {/* Today's Total Time Card */}
        <div className="bg-white p-4 rounded-xl border border-[#E6E8EF] space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[9px] font-bold text-[#98A2B3] uppercase tracking-wider flex items-center gap-1">
              <Clock className="h-3 w-3" /> Today's Total
            </p>
            <p className="text-[18px] font-bold text-[#111827] font-mono">
              {formatTotalTime(completedMinutesToday + (isClockedIn ? Math.floor((Date.now() - new Date(activeSession!.clock_in).getTime()) / 60000) : 0))}
            </p>
          </div>
          {todaySessions.length > 0 && (
            <>
              <button
                onClick={() => setShowSessionHistory(!showSessionHistory)}
                className="flex items-center gap-1 text-[10px] text-[#3B82F6] font-semibold hover:underline"
              >
                <History className="h-3 w-3" />
                {showSessionHistory ? 'Hide' : 'Show'} Sessions ({todaySessions.length})
                {showSessionHistory ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
              {showSessionHistory && (
                <div className="space-y-1 pt-1 border-t border-[#F1F4FA]">
                  {todaySessions.map(s => {
                    const clockIn = new Date(s.clock_in)
                    const clockOut = s.clock_out ? new Date(s.clock_out) : null
                    const fmtTime = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    const duration = s.total_minutes ? formatTotalTime(s.total_minutes) : (s.status === 'active' ? 'running' : '–')
                    return (
                      <div key={s.id} className="flex items-center justify-between text-[10px] py-1">
                        <span className="text-[#667085]">
                          {fmtTime(clockIn)} → {clockOut ? fmtTime(clockOut) : <span className="text-[#16A34A] font-semibold">Now</span>}
                        </span>
                        <span className={`font-semibold ${s.status === 'active' ? 'text-[#16A34A]' : 'text-[#111827]'}`}>
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
            <p className="text-[10px] text-[#98A2B3]">No sessions logged today yet.</p>
          )}
        </div>

        {/* Active Web Task Section */}
        <div className="bg-white p-3 rounded-xl border border-[#E6E8EF] space-y-1.5">
          <p className="text-[9px] font-bold text-[#98A2B3] uppercase tracking-wider">Active Web Task</p>
          <div className="flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full shrink-0 ${isClockedIn && activeWebTask !== 'No active web task' ? 'bg-[#3B82F6]' : 'bg-[#98A2B3]'}`} />
            <p className="text-[12px] font-medium text-[#111827] truncate">
              {activeWebTask}
            </p>
          </div>
        </div>

        {/* Activity Tracking Status */}
        {profile?.activity_tracking_enabled && (
          <div className="bg-white p-3 rounded-xl border border-[#E6E8EF] space-y-1.5">
            <p className="text-[9px] font-bold text-[#98A2B3] uppercase tracking-wider">Activity Status</p>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className={`h-2 w-2 rounded-full shrink-0 ${
                  activityStatus === 'Active' ? 'bg-[#10B981]' : 
                  activityStatus === 'Idle' ? 'bg-[#F59E0B]' : 'bg-[#98A2B3]'
                }`} />
                <p className="text-[12px] font-medium text-[#111827] truncate">
                  {activityStatus === 'Disabled' ? 'Tracking Disabled' : activityStatus}
                </p>
              </div>
              {activityStatus !== 'Disabled' && (
                <div className="text-[11px] font-semibold text-[#667085]">
                  {activePercentage}% Active
                </div>
              )}
            </div>
          </div>
        )}

        {/* Permissions & OS Checklist */}
        <div className="bg-white p-3 rounded-xl border border-[#E6E8EF] space-y-2">
          <p className="text-[9px] font-bold text-[#98A2B3] uppercase tracking-wider flex items-center gap-1">
            <ShieldCheck className={`h-3.5 w-3.5 ${allPermissionsGranted ? 'text-[#10B981]' : 'text-[#F59E0B]'}`} /> Hardware Permissions
          </p>
          
          {allPermissionsGranted ? (
            <div className="flex items-center gap-1.5 text-[11px] text-[#16A34A] font-semibold">
              <span className="text-[#16A34A]">✓</span> All permissions granted
            </div>
          ) : (
            <div className="space-y-1.5 text-[11px]">
              <div className="flex items-center justify-between py-1 border-b border-[#F7F8FC]">
                <span className="text-[#667085]">Screen Capture</span>
                <div className="flex items-center gap-1.5">
                  <span className={`font-semibold capitalize ${permissions.screen === 'granted' ? 'text-[#16A34A]' : 'text-red-500'}`}>
                    {permissions.screen}
                  </span>
                  {permissions.screen !== 'granted' && (
                    <button 
                      onClick={() => requestPermission('screen')} 
                      className="text-[10px] text-[#3B82F6] hover:underline"
                    >
                      Allow
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between py-1">
                <span className="text-[#667085]">Accessibility (Events)</span>
                <div className="flex items-center gap-1.5">
                  <span className={`font-semibold capitalize ${permissions.accessibility === 'granted' ? 'text-[#16A34A]' : 'text-red-500'}`}>
                    {permissions.accessibility}
                  </span>
                  {permissions.accessibility !== 'granted' && (
                    <button 
                      onClick={() => requestPermission('accessibility')} 
                      className="text-[10px] text-[#3B82F6] hover:underline"
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
      <div className="p-5 bg-white border-t border-[#E6E8EF] shadow-md flex flex-col gap-3 shrink-0">
        
        {/* Phase 4D: Sync Manager UI */}
        {(queueStats.pendingCount > 0 || queueStats.failedCount > 0 || !isOnline) && (
          <div className="flex items-center justify-between bg-[#F7F8FC] p-2.5 rounded-xl border border-[#E6E8EF]">
            <div className="flex items-center gap-2 text-[11px] text-[#667085] font-medium">
              <RefreshCw className={`h-3.5 w-3.5 ${!isOnline ? 'text-gray-400' : (queueStats.pendingCount > 0 ? 'text-[#3B82F6] animate-spin' : 'text-[#16A34A]')}`} />
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
                className="text-[10px] text-white bg-[#EF4444] px-2 py-1 rounded-lg font-bold hover:bg-[#DC2626]"
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
              className="flex-1 h-11 bg-[#EF4444] text-white hover:bg-[#DC2626] active:scale-98 disabled:opacity-50 font-semibold rounded-xl text-[14px] flex items-center justify-center gap-1.5 transition-all shadow-sm"
            >
              <Square className="h-4 w-4" /> Clock Out
            </button>
          ) : (
            <button
              onClick={handleClockIn}
              disabled={syncing}
              className="flex-1 h-11 bg-[#10B981] text-white hover:bg-[#059669] active:scale-98 disabled:opacity-50 font-semibold rounded-xl text-[14px] flex items-center justify-center gap-1.5 transition-all shadow-sm"
            >
              <Play className="h-4 w-4 fill-white ml-0.5" /> Clock In
            </button>
          )}
        </div>

        {/* Footer info: Last Sync and Version */}
        <div className="flex justify-between items-center text-[10px] text-[#98A2B3] px-1 pt-1 select-none">
          <div>
            {isClockedIn && (
              heartbeatFailed ? (
                <span className="text-red-500 font-semibold animate-pulse">Sync issue. Retrying...</span>
              ) : (
                <span>Last Sync: {lastSyncTime || 'Pending...'}</span>
              )
            )}
          </div>
          <div>vOps Tracker v0.5A</div>
        </div>
      </div>
    </div>
  )
}
