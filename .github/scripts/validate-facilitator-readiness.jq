def listening_port:
  [.env[]? | select(.name == "PORT")] as $vars
  | if ($vars | length) == 0 then
      if (.envFrom // [] | length) == 0 then 4020 else null end
    elif ($vars | length) == 1 and $vars[0].valueFrom == null then
      ($vars[0].value // "")
      | if . == "" then 4020 elif test("^[0-9]+$") then tonumber else null end
    else null end;

listening_port as $port
| .readinessProbe.httpGet as $probe
| $port != null and $port >= 1 and $port <= 65535
  and $probe.path == "/health" and ($probe.scheme // "HTTP") == "HTTP" and ($probe.host // "") == ""
  and (.readinessProbe.timeoutSeconds // 1) >= 25
  and (if ($probe.port | type) == "string" then
    any(.ports[]?; .name == $probe.port and .containerPort == $port and (.protocol // "TCP") == "TCP")
  else $probe.port == $port end)
