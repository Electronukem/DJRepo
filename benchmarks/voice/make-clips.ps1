# Speaks every command in commands.json with two of Windows' built-in voices, as the 16 kHz mono
# 16-bit WAV that Muse Voice Transcribe takes, into clips/. The clips are committed, so the benchmark
# runs anywhere; this is only needed to change them. Windows PowerShell or PowerShell 7 on Windows:
#
#   powershell -File benchmarks/voice/make-clips.ps1

Add-Type -AssemblyName System.Speech
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$commands = Get-Content (Join-Path $here 'commands.json') -Raw | ConvertFrom-Json
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$voices = @{ 'david' = 'Microsoft David Desktop'; 'zira' = 'Microsoft Zira Desktop' }
foreach ($voice in $voices.GetEnumerator()) {
  foreach ($command in $commands) {
    $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $speaker.SelectVoice($voice.Value)
    $speaker.SetOutputToWaveFile((Join-Path $here "clips\$($command.id)-$($voice.Key).wav"), $format)
    $speaker.Speak($command.say)
    $speaker.Dispose()
  }
}
