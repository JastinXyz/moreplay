package dev.droidreplay.agent;

import android.app.UiAutomation;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import org.json.JSONArray;
import org.json.JSONObject;

/** All device operations. Every op takes a JSON step and returns a short message or throws. */
final class Device {
    private static final int MAX_LABEL = 100;
    private static final long POLL_MS = 40;

    private final UiAutomation automation;
    private final Method injectNoAnimWait;
    // Tap targets from the latest observe, so steps can say {"ref": 12}.
    private final Map<Integer, int[]> refs = new HashMap<>();

    Device(UiAutomation automation) {
        this.automation = automation;
        Method m = null;
        try {
            // Hidden 3-arg variant (API 33+). The public 2-arg one also waits for animations to end (~1 s).
            m = UiAutomation.class.getDeclaredMethod("injectInputEvent", InputEvent.class, boolean.class, boolean.class);
            m.setAccessible(true);
        } catch (NoSuchMethodException ignored) {
        }
        injectNoAnimWait = m;
    }

    JSONObject run(JSONArray steps, boolean stopOnError) throws Exception {
        long t0 = SystemClock.uptimeMillis();
        JSONArray results = new JSONArray();
        boolean allOk = true;
        for (int i = 0; i < steps.length(); i++) {
            JSONObject step = steps.getJSONObject(i);
            String op = step.optString("op");
            long s0 = SystemClock.uptimeMillis();
            JSONObject r = new JSONObject().put("op", op);
            try {
                r.put("ok", true).put("out", exec(op, step));
            } catch (Exception e) {
                allOk = false;
                r.put("ok", false).put("error", e.getMessage() != null ? e.getMessage() : e.toString());
            }
            r.put("ms", SystemClock.uptimeMillis() - s0);
            results.put(r);
            if (!r.getBoolean("ok") && stopOnError) break;
        }
        return new JSONObject().put("ok", allOk).put("results", results).put("ms", SystemClock.uptimeMillis() - t0);
    }

    private String exec(String op, JSONObject s) throws Exception {
        switch (op) {
            case "observe": return observe();
            case "tap": return tap(s, false);
            case "long_press": return tap(s, true);
            case "type": return type(s);
            case "swipe": return swipe(s.getInt("x1"), s.getInt("y1"), s.getInt("x2"), s.getInt("y2"), s.optInt("ms", 250));
            case "scroll": return scroll(s);
            case "key": return key(s.getString("key"));
            case "wait_for": return waitFor(s, false);
            case "wait_gone": return waitFor(s, true);
            case "wait_idle": return waitIdle(s.optInt("quietMs", 300), s.optInt("timeout", 5000));
            case "sleep": SystemClock.sleep(s.getLong("ms")); return "ok";
            default: throw new IllegalArgumentException("unknown op: " + op);
        }
    }

    // ---------------------------------------------------------------- observe

    String observe() {
        AccessibilityNodeInfo root = automation.getRootInActiveWindow();
        refs.clear();
        if (root == null) return "(no active window)";
        StringBuilder sb = new StringBuilder();
        sb.append("app=").append(root.getPackageName()).append('\n');
        walk(root, sb, false);
        return sb.toString();
    }

    /**
     * One line per node worth knowing about. Text inside a clickable node is folded into that
     * node's label, so an icon + title + container shows up once instead of three times.
     */
    private void walk(AccessibilityNodeInfo n, StringBuilder sb, boolean absorbed) {
        if (n == null || !n.isVisibleToUser()) return;
        boolean pressable = n.isClickable() || n.isLongClickable() || n.isCheckable();
        boolean emit;
        String label;
        if (pressable) {
            emit = true;
            Set<String> parts = new LinkedHashSet<>();
            addText(n, parts);
            collectText(n, parts);
            label = join(parts);
        } else if (n.isEditable() || n.isScrollable()) {
            emit = true;
            Set<String> parts = new LinkedHashSet<>();
            addText(n, parts);
            label = join(parts);
        } else {
            Set<String> parts = new LinkedHashSet<>();
            addText(n, parts);
            label = join(parts);
            emit = !absorbed && !label.isEmpty();
        }

        if (emit) {
            Rect r = new Rect();
            n.getBoundsInScreen(r);
            int ref = refs.size();
            refs.put(ref, new int[]{r.centerX(), r.centerY()});
            sb.append('@').append(ref).append(' ').append(shortClass(n.getClassName()));
            if (!label.isEmpty()) sb.append(" \"").append(label).append('"');
            String id = n.getViewIdResourceName();
            if (id != null) sb.append(" #").append(id.substring(id.indexOf('/') + 1));
            if (n.isEditable() && n.getHintText() != null && n.getHintText().length() > 0) {
                sb.append(" hint=\"").append(n.getHintText()).append('"');
            }
            sb.append(" [").append(r.centerX()).append(',').append(r.centerY()).append(']');
            if (n.isClickable()) sb.append(" tap");
            if (n.isEditable()) sb.append(" edit");
            if (n.isScrollable()) sb.append(" scroll");
            if (n.isCheckable()) sb.append(n.isChecked() ? " on" : " off");
            if (n.isSelected()) sb.append(" selected");
            if (!n.isEnabled()) sb.append(" disabled");
            sb.append('\n');
        }
        // Children of a pressable node had their text folded in above; only their own actions show.
        boolean childAbsorbed = absorbed || pressable;
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChild(i), sb, childAbsorbed);
    }

    private static void addText(AccessibilityNodeInfo n, Set<String> parts) {
        CharSequence t = n.getText();
        CharSequence d = n.getContentDescription();
        if (t != null && t.toString().trim().length() > 0) parts.add(t.toString().trim());
        if (d != null && d.toString().trim().length() > 0) parts.add(d.toString().trim());
    }

    private static void collectText(AccessibilityNodeInfo n, Set<String> parts) {
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo c = n.getChild(i);
            if (c == null || !c.isVisibleToUser()) continue;
            if (c.isClickable() || c.isCheckable()) continue; // gets its own line
            addText(c, parts);
            collectText(c, parts);
        }
    }

    private static String join(Set<String> parts) {
        String s = String.join(" · ", parts).replace('\n', ' ').replace("\"", "'");
        return s.length() > MAX_LABEL ? s.substring(0, MAX_LABEL) + "…" : s;
    }

    private static String shortClass(CharSequence cls) {
        if (cls == null) return "View";
        String s = cls.toString();
        return s.substring(s.lastIndexOf('.') + 1);
    }

    // ---------------------------------------------------------------- selectors

    /** Resolves a step's selector (ref | x,y | text | id | desc) to a screen point. */
    private int[] point(JSONObject s) {
        if (s.has("ref")) {
            int[] p = refs.get(s.optInt("ref"));
            if (p == null) throw new IllegalArgumentException("unknown ref @" + s.optInt("ref") + " (observe again)");
            return p;
        }
        if (s.has("x") && s.has("y")) return new int[]{s.optInt("x"), s.optInt("y")};
        AccessibilityNodeInfo n = find(s);
        if (n == null) throw new IllegalArgumentException("not found: " + describe(s));
        AccessibilityNodeInfo target = n;
        // Text usually sits on a child of the thing that is actually clickable.
        while (target != null && !target.isClickable() && !target.isEditable()) target = target.getParent();
        if (target == null) target = n;
        Rect r = new Rect();
        target.getBoundsInScreen(r);
        return new int[]{r.centerX(), r.centerY()};
    }

    private AccessibilityNodeInfo find(JSONObject s) {
        if (!s.has("text") && !s.has("id") && !s.has("desc")) {
            throw new IllegalArgumentException("selector needs ref, x/y, text, id or desc");
        }
        AccessibilityNodeInfo root = automation.getRootInActiveWindow();
        if (root == null) return null;
        List<AccessibilityNodeInfo> all = new ArrayList<>();
        flatten(root, all);
        AccessibilityNodeInfo partial = null;
        for (AccessibilityNodeInfo n : all) {
            int m = match(n, s);
            if (m == 2) return n;
            if (m == 1 && partial == null) partial = n;
        }
        return partial;
    }

    private static void flatten(AccessibilityNodeInfo n, List<AccessibilityNodeInfo> out) {
        if (n == null || !n.isVisibleToUser()) return;
        out.add(n);
        for (int i = 0; i < n.getChildCount(); i++) flatten(n.getChild(i), out);
    }

    /** 2 = exact match, 1 = contains match (text/desc only), 0 = no match. */
    private static int match(AccessibilityNodeInfo n, JSONObject s) {
        int score = 2;
        if (s.has("id")) {
            String id = n.getViewIdResourceName();
            String want = s.optString("id");
            if (id == null || !(id.equals(want) || id.endsWith("/" + want))) return 0;
        }
        if (s.has("text")) score = Math.min(score, textScore(n.getText(), n.getContentDescription(), s.optString("text")));
        if (s.has("desc")) score = Math.min(score, textScore(n.getContentDescription(), null, s.optString("desc")));
        return score;
    }

    private static int textScore(CharSequence a, CharSequence b, String want) {
        String w = want.trim().toLowerCase(Locale.ROOT);
        int best = 0;
        for (CharSequence cs : new CharSequence[]{a, b}) {
            if (cs == null) continue;
            String v = cs.toString().trim().toLowerCase(Locale.ROOT);
            if (v.equals(w)) return 2;
            if (!w.isEmpty() && v.contains(w)) best = 1;
        }
        return best;
    }

    private static String describe(JSONObject s) {
        StringBuilder sb = new StringBuilder();
        for (String k : new String[]{"text", "id", "desc"}) {
            if (s.has(k)) sb.append(sb.length() > 0 ? " " : "").append(k).append("=\"").append(s.optString(k)).append('"');
        }
        return sb.toString();
    }

    // ---------------------------------------------------------------- actions

    private boolean inject(InputEvent ev, boolean sync) {
        try {
            if (injectNoAnimWait != null) return (Boolean) injectNoAnimWait.invoke(automation, ev, sync, false);
        } catch (Exception e) {
            System.err.println("3-arg inject failed, falling back: " + e);
        }
        return automation.injectInputEvent(ev, sync);
    }

    private boolean touch(int action, long down, long at, int x, int y, boolean sync) {
        MotionEvent ev = MotionEvent.obtain(down, at, action, x, y, 0);
        ev.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        boolean ok = inject(ev, sync);
        ev.recycle();
        return ok;
    }

    private String tap(JSONObject s, boolean longPress) {
        int[] p = point(s);
        long down = SystemClock.uptimeMillis();
        boolean ok = touch(MotionEvent.ACTION_DOWN, down, down, p[0], p[1], true);
        if (longPress) SystemClock.sleep(s.optLong("ms", 700));
        ok &= touch(MotionEvent.ACTION_UP, down, SystemClock.uptimeMillis(), p[0], p[1], true);
        if (!ok) throw new IllegalStateException("inject failed (Xiaomi: enable 'USB debugging (Security settings)')");
        return "tapped " + p[0] + "," + p[1];
    }

    private String swipe(int x1, int y1, int x2, int y2, int ms) {
        long down = SystemClock.uptimeMillis();
        touch(MotionEvent.ACTION_DOWN, down, down, x1, y1, false);
        int steps = Math.max(ms / 16, 4);
        for (int i = 1; i < steps; i++) {
            SystemClock.sleep(ms / steps);
            float f = (float) i / steps;
            touch(MotionEvent.ACTION_MOVE, down, SystemClock.uptimeMillis(),
                    (int) (x1 + (x2 - x1) * f), (int) (y1 + (y2 - y1) * f), false);
        }
        boolean ok = touch(MotionEvent.ACTION_UP, down, SystemClock.uptimeMillis(), x2, y2, true);
        if (!ok) throw new IllegalStateException("inject failed");
        return "swiped";
    }

    /** {"dir":"down"} scrolls content down (finger moves up). With "until", repeats until it is visible. */
    private String scroll(JSONObject s) {
        String dir = s.optString("dir", "down");
        int max = s.optInt("max", 10);
        JSONObject until = s.optJSONObject("until");
        Rect screen = new Rect();
        AccessibilityNodeInfo root = automation.getRootInActiveWindow();
        if (root != null) root.getBoundsInScreen(screen);
        int cx = screen.centerX();
        int top = screen.top + screen.height() / 4;
        int bottom = screen.bottom - screen.height() / 4;

        for (int i = 0; i <= max; i++) {
            if (until != null && find(until) != null) return "found after " + i + " scroll(s)";
            if (i == max) break;
            String before = until != null ? observe() : null;
            switch (dir) {
                case "down": swipe(cx, bottom, cx, top, 250); break;
                case "up": swipe(cx, top, cx, bottom, 250); break;
                case "left": swipe(screen.right - screen.width() / 5, screen.centerY(), screen.left + screen.width() / 5, screen.centerY(), 250); break;
                case "right": swipe(screen.left + screen.width() / 5, screen.centerY(), screen.right - screen.width() / 5, screen.centerY(), 250); break;
                default: throw new IllegalArgumentException("dir must be up/down/left/right");
            }
            if (until == null) return "scrolled " + dir;
            waitIdle(200, 1500);
            if (observe().equals(before)) break; // hit the end of the list
        }
        if (until != null) throw new IllegalStateException("not found after scrolling: " + describe(until));
        return "scrolled " + dir;
    }

    /** {"value":"..."} into the focused field, or first taps the field given by ref/x,y/id/desc/field (its text). */
    private String type(JSONObject s) throws Exception {
        AccessibilityNodeInfo field;
        JSONObject sel = new JSONObject();
        for (String k : new String[]{"ref", "x", "y", "id", "desc"}) if (s.has(k)) sel.put(k, s.opt(k));
        if (s.has("field")) sel.put("text", s.optString("field"));
        if (sel.length() > 0) {
            tap(sel, false);
            SystemClock.sleep(150);
        }
        AccessibilityNodeInfo root = automation.getRootInActiveWindow();
        field = root == null ? null : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (field == null || !field.isEditable()) throw new IllegalStateException("no focused text field");
        String value = s.optString("value");
        if (s.optBoolean("append", false) && field.getText() != null) value = field.getText() + value;
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) throw new IllegalStateException("set text failed");
        if (s.optBoolean("submit", false)) key("enter");
        return "typed " + value.length() + " chars";
    }

    private String key(String name) {
        int code;
        switch (name.toLowerCase(Locale.ROOT)) {
            case "back": code = KeyEvent.KEYCODE_BACK; break;
            case "home": code = KeyEvent.KEYCODE_HOME; break;
            case "enter": code = KeyEvent.KEYCODE_ENTER; break;
            case "recents": code = KeyEvent.KEYCODE_APP_SWITCH; break;
            case "delete": code = KeyEvent.KEYCODE_DEL; break;
            case "tab": code = KeyEvent.KEYCODE_TAB; break;
            default:
                try {
                    code = Integer.parseInt(name);
                } catch (NumberFormatException e) {
                    throw new IllegalArgumentException("unknown key: " + name);
                }
        }
        long now = SystemClock.uptimeMillis();
        boolean ok = inject(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, 0, -1, 0, 0, InputDevice.SOURCE_KEYBOARD), true);
        ok &= inject(new KeyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0, 0, -1, 0, 0, InputDevice.SOURCE_KEYBOARD), true);
        if (!ok) throw new IllegalStateException("inject failed");
        return "pressed " + name;
    }

    // ---------------------------------------------------------------- waits

    private String waitFor(JSONObject s, boolean gone) {
        long deadline = SystemClock.uptimeMillis() + s.optLong("timeout", 5000);
        long t0 = SystemClock.uptimeMillis();
        while (true) {
            boolean present = find(s) != null;
            if (present != gone) return (gone ? "gone" : "found") + " after " + (SystemClock.uptimeMillis() - t0) + "ms";
            if (SystemClock.uptimeMillis() > deadline) {
                throw new IllegalStateException("timeout waiting for " + (gone ? "gone: " : "") + describe(s));
            }
            SystemClock.sleep(POLL_MS);
        }
    }

    /** Waits until the observed tree stops changing for quietMs. Cheap substitute for "app is idle". */
    String waitIdle(int quietMs, int timeout) {
        long t0 = SystemClock.uptimeMillis();
        long deadline = t0 + timeout;
        String last = observe();
        long stableSince = SystemClock.uptimeMillis();
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(POLL_MS);
            String now = observe();
            if (!now.equals(last)) {
                last = now;
                stableSince = SystemClock.uptimeMillis();
            } else if (SystemClock.uptimeMillis() - stableSince >= quietMs) {
                return "idle after " + (SystemClock.uptimeMillis() - t0) + "ms";
            }
        }
        return "still changing after " + timeout + "ms";
    }

    // ---------------------------------------------------------------- screenshot

    byte[] screenshot(int max, int quality) {
        Bitmap bmp = automation.takeScreenshot();
        if (bmp == null) throw new IllegalStateException("screenshot failed (secure window?)");
        int w = bmp.getWidth();
        int h = bmp.getHeight();
        int longest = Math.max(w, h);
        if (max > 0 && longest > max) {
            float f = (float) max / longest;
            Bitmap scaled = Bitmap.createScaledBitmap(bmp, Math.round(w * f), Math.round(h * f), true);
            bmp.recycle();
            bmp = scaled;
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.JPEG, quality, out);
        bmp.recycle();
        return out.toByteArray();
    }
}
