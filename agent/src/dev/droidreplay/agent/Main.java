package dev.droidreplay.agent;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

import org.json.JSONObject;

/**
 * Device-side agent, launched via:
 *   CLASSPATH=/data/local/tmp/droidreplay.jar app_process / dev.droidreplay.agent.Main [port]
 * Holds one UiAutomation connection for its whole lifetime and serves a tiny HTTP API:
 *   GET  /ping
 *   POST /run         {"steps":[{op:...}], "stopOnError":true}  -> JSON results
 *   GET  /screenshot  ?max=1024&q=75                             -> image/jpeg
 */
public final class Main {
    // UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES: keep TalkBack & co alive.
    private static final int FLAG_DONT_SUPPRESS_A11Y = 1;

    public static void main(String[] args) throws Exception {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : 9070;

        long t0 = SystemClock.uptimeMillis();
        UiAutomation automation = connectUiAutomation();
        AccessibilityServiceInfo info = automation.getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        automation.setServiceInfo(info);
        Device device = new Device(automation);
        System.out.println("uiautomation connected in " + (SystemClock.uptimeMillis() - t0) + "ms");

        try (ServerSocket server = new ServerSocket(port, 8, InetAddress.getByName("127.0.0.1"))) {
            System.out.println("listening on 127.0.0.1:" + port);
            while (true) {
                try (Socket s = server.accept()) {
                    handle(s, device);
                } catch (Exception e) {
                    System.err.println("request failed: " + e);
                }
            }
        }
    }

    private static UiAutomation connectUiAutomation() throws Exception {
        HandlerThread thread = new HandlerThread("droidreplay-uia");
        thread.start();
        Looper looper = thread.getLooper();

        Class<?> connClass = Class.forName("android.app.UiAutomationConnection");
        Object connection = connClass.getDeclaredConstructor().newInstance();

        UiAutomation ua = null;
        for (Constructor<?> c : UiAutomation.class.getDeclaredConstructors()) {
            Class<?>[] p = c.getParameterTypes();
            if (p.length == 2 && p[0] == Looper.class) {
                c.setAccessible(true);
                ua = (UiAutomation) c.newInstance(looper, connection);
                break;
            }
        }
        if (ua == null) throw new IllegalStateException("no UiAutomation(Looper, conn) constructor");

        try {
            Method m = UiAutomation.class.getDeclaredMethod("connectWithTimeout", int.class, long.class);
            m.setAccessible(true);
            m.invoke(ua, FLAG_DONT_SUPPRESS_A11Y, 5000L);
        } catch (NoSuchMethodException e) {
            Method m = UiAutomation.class.getDeclaredMethod("connect", int.class);
            m.setAccessible(true);
            m.invoke(ua, FLAG_DONT_SUPPRESS_A11Y);
        }
        return ua;
    }

    private static void handle(Socket s, Device device) throws Exception {
        InputStream in = s.getInputStream();
        String head = readHead(in);
        if (head.isEmpty()) return;
        String[] lines = head.split("\r\n");
        String[] requestLine = lines[0].split(" ");
        String method = requestLine[0];
        String target = requestLine[1];

        int contentLength = 0;
        for (int i = 1; i < lines.length; i++) {
            String l = lines[i].toLowerCase(Locale.ROOT);
            if (l.startsWith("content-length:")) contentLength = Integer.parseInt(l.substring(15).trim());
        }
        byte[] body = new byte[contentLength];
        int read = 0;
        while (read < contentLength) {
            int n = in.read(body, read, contentLength - read);
            if (n < 0) break;
            read += n;
        }

        String path = target;
        Map<String, String> query = new HashMap<>();
        int qi = target.indexOf('?');
        if (qi >= 0) {
            path = target.substring(0, qi);
            for (String kv : target.substring(qi + 1).split("&")) {
                int eq = kv.indexOf('=');
                if (eq > 0) query.put(kv.substring(0, eq), java.net.URLDecoder.decode(kv.substring(eq + 1), "UTF-8"));
            }
        }

        OutputStream out = s.getOutputStream();
        try {
            if (path.equals("/ping")) {
                respond(out, 200, "text/plain", "pong".getBytes(StandardCharsets.UTF_8));
            } else if (path.equals("/run") && method.equals("POST")) {
                JSONObject req = new JSONObject(new String(body, StandardCharsets.UTF_8));
                JSONObject res = device.run(req.getJSONArray("steps"), req.optBoolean("stopOnError", true));
                respond(out, 200, "application/json", res.toString().getBytes(StandardCharsets.UTF_8));
            } else if (path.equals("/screenshot")) {
                int max = Integer.parseInt(query.getOrDefault("max", "0"));
                int quality = Integer.parseInt(query.getOrDefault("q", "80"));
                respond(out, 200, "image/jpeg", device.screenshot(max, quality));
            } else {
                respond(out, 404, "text/plain", "not found".getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            respond(out, 500, "text/plain", String.valueOf(e).getBytes(StandardCharsets.UTF_8));
        }
    }

    private static String readHead(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int state = 0;
        int b;
        while ((b = in.read()) >= 0) {
            buf.write(b);
            // Stop at the blank line that ends the headers (\r\n\r\n).
            if ((state % 2 == 0 && b == '\r') || (state % 2 == 1 && b == '\n')) state++;
            else state = b == '\r' ? 1 : 0;
            if (state == 4) break;
        }
        return buf.toString("UTF-8").trim();
    }

    private static void respond(OutputStream out, int status, String type, byte[] body) throws Exception {
        out.write(("HTTP/1.1 " + status + " X\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
                + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }
}
