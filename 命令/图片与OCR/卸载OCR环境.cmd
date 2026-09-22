@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 卸载图片识别环境

rem 本文件在「命令\图片与OCR\」下，项目根在两级之上。
cd /d "%~dp0..\.."
if not exist "scripts\" (
  echo   [错误] 没找到项目根目录 —— 请不要单独移动本文件，放回 命令\图片与OCR\ 再试。
  pause
  exit /b 1
)
set "ROOT=%CD%\"
set "ENV=%ROOT%.ocr-env"
set "DATA=%ROOT%data"

echo.
echo  ============================================================
echo   卸载图片识别环境（本地 OCR + 图片内容描述）
echo  ============================================================
echo.
echo   安装使用过程写入的全部内容只有下面几处，没有别的地方：
echo.
echo   [1] %ENV%
echo       ^(Python 运行环境 + OCR 模型，约 330 MB^)
echo.
echo   [2] %DATA%\ocr.json / ocr.js
echo       %DATA%\vlm.json / vlm.js
echo       ^(图片索引：文字 + 内容描述，合计几百 KB^)
echo.
echo   [3] %DATA%\glm_key.txt
echo       ^(智谱 API Key，几十字节，删了要重新填^)
echo.
echo   提示：删除 [1] 之后图片搜索依然可用，
echo         因为索引 [2] 是纯数据，浏览器直接读取。
echo         想继续搜索就保留 [2]，想彻底清空再一起删。
echo.

if not exist "%ENV%" (
  echo   [信息] 没找到 .ocr-env，运行环境已经卸载过了。
  echo.
  goto ask_index
)

echo  ------------------------------------------------------------
set /p "ANS= 是否删除运行环境 [1] ?  (Y/N) "
if /i not "%ANS%"=="Y" goto ask_index

echo.
echo   正在删除运行环境，请稍候...
rmdir /s /q "%ENV%" 2>nul
if exist "%ENV%" (
  echo   [失败] 删除未完成，可能有程序正在占用该文件夹。
  echo          请关闭相关窗口后重试。
) else (
  echo   [完成] 运行环境已删除，释放约 330 MB。
)

:ask_index
echo.
echo  ------------------------------------------------------------
if not exist "%DATA%\ocr.json" if not exist "%DATA%\vlm.json" (
  echo   [信息] 没找到索引文件，索引也已经清空了。
  goto ask_key
)

set /p "ANS2= 是否同时删除图片索引 [2] ?  (Y/N) "
if /i not "%ANS2%"=="Y" goto keep_index
del /q "%DATA%\ocr.json" 2>nul
del /q "%DATA%\ocr.js" 2>nul
del /q "%DATA%\ocr.json.tmp" 2>nul
del /q "%DATA%\vlm.json" 2>nul
del /q "%DATA%\vlm.js" 2>nul
del /q "%DATA%\vlm.json.tmp" 2>nul
echo   [完成] 索引已删除。搜索框将不再匹配图片内容。
goto ask_key

:keep_index
echo   [保留] 索引已保留，图片搜索照常可用。

:ask_key
echo.
echo  ------------------------------------------------------------
if not exist "%DATA%\glm_key.txt" (
  echo   [信息] 没找到 glm_key.txt，API Key 也已经删除了。
  goto done
)

set /p "ANS3= 是否同时删除智谱 API Key [3] ?  (Y/N) "
if /i not "%ANS3%"=="Y" goto keep_key
del /q "%DATA%\glm_key.txt" 2>nul
echo   [完成] API Key 已删除。
goto done

:keep_key
echo   [保留] API Key 已保留。

:done
echo.
echo  ============================================================
echo   卸载流程结束
echo  ============================================================
echo.
echo   想重新启用（重新下载约 330 MB）：
echo     "%~dp0安装OCR环境.cmd"
echo.
pause
endlocal
