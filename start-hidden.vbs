' Starts the Pit Wall server with no console window. Used at login (Startup folder) and by "Pit Wall.cmd".
' If it is already running, the second copy sees the port in use and exits quietly.
' With the argument "open" (team installs' Startup shortcut) it also opens the page once the server answers.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists(root & "\data") Then fso.CreateFolder(root & "\data")
sh.CurrentDirectory = root
sh.Run "cmd /c node src\server.mjs >> data\server.log 2>&1", 0, False

If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "open" Then
    port = sh.ExpandEnvironmentStrings("%PITWALL_PORT%")
    If port = "%PITWALL_PORT%" Then port = "4040"
    url = "http://127.0.0.1:" & port & "/"
    For i = 1 To 60
      WScript.Sleep 1000
      On Error Resume Next
      Set req = CreateObject("MSXML2.ServerXMLHTTP.6.0")
      req.setTimeouts 1000, 1000, 1000, 1000
      req.Open "GET", url, False
      req.Send
      ok = (Err.Number = 0)
      If ok Then ok = (req.Status = 200)
      Err.Clear
      On Error GoTo 0
      If ok Then
        sh.Run url
        Exit For
      End If
    Next
  End If
End If
