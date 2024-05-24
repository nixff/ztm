@ECHO off

CD %~dp0
CALL build\deps.cmd
CALL build\gui.cmd
CALL build\pipy.cmd

IF NOT EXIST bin (MD bin)
COPY pipy\bin\Release\pipy.exe bin\ztm.exe

ECHO The final product is ready at bin\ztm.exe

tar.exe -a -c -f ztm-cli-%ZTM_VERSION%-win-x86_64.zip bin\ztm.exe
dir
