# Shows a Windows notification. Text arrives in environment variables (never on the command line),
# and is XML-escaped here, so nothing in a session name or message can break out.
$ErrorActionPreference = 'Stop'
$title = [Security.SecurityElement]::Escape($env:PW_TITLE)
$body = [Security.SecurityElement]::Escape($env:PW_BODY)
$url = [Security.SecurityElement]::Escape($env:PW_URL)
$xml = "<toast activationType=`"protocol`" launch=`"$url`"><visual><binding template=`"ToastGeneric`"><text>$title</text><text>$body</text></binding></visual><audio src=`"ms-winsoundevent:Notification.Default`"/></toast>"
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
# PowerShell's own app id is registered on every Windows install, so no setup is needed.
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($doc))
