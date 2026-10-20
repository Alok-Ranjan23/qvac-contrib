if(NOT BUILD_HEXAGON_BACKEND)
  list(APPEND PLATFORM_OPTIONS -DGGML_HEXAGON=OFF)
  return()
endif()

if(NOT VCPKG_TARGET_IS_ANDROID OR NOT VCPKG_TARGET_ARCHITECTURE STREQUAL "arm64")
  message(FATAL_ERROR "qvac-fabric: hexagon-backend requires Android arm64")
endif()

set(QVAC_HEXAGON_SDK_ROOT "$ENV{HEXAGON_SDK_ROOT}")
if(NOT EXISTS "${QVAC_HEXAGON_SDK_ROOT}/hexagon_sdk.json")
  message(FATAL_ERROR "qvac-fabric: hexagon-backend requires HEXAGON_SDK_ROOT pointing to Hexagon SDK 6.6.0.0")
endif()

# The SDK and tools pins are part of the port hash; the consumer triplet must
# also track HEXAGON_SDK_ROOT and HEXAGON_TOOLS_ROOT in VCPKG_ENV_PASSTHROUGH.
file(READ "${QVAC_HEXAGON_SDK_ROOT}/hexagon_sdk.json" sdk_json)
string(JSON sdk_version GET "${sdk_json}" root id version)
if(NOT sdk_version STREQUAL "6.6.0.0")
  message(FATAL_ERROR "qvac-fabric: hexagon-backend expects SDK 6.6.0.0, found ${sdk_version}")
endif()

set(QVAC_HEXAGON_TOOLS_ROOT "$ENV{HEXAGON_TOOLS_ROOT}")
if(QVAC_HEXAGON_TOOLS_ROOT STREQUAL "")
  string(JSON tools_path GET "${sdk_json}" root tools info 0 path)
  set(QVAC_HEXAGON_TOOLS_ROOT "${QVAC_HEXAGON_SDK_ROOT}/${tools_path}")
endif()
find_program(QVAC_HEXAGON_CLANG NAMES hexagon-clang hexagon-clang.exe
  PATHS "${QVAC_HEXAGON_TOOLS_ROOT}/Tools/bin" NO_DEFAULT_PATH REQUIRED)
execute_process(
  COMMAND "${QVAC_HEXAGON_CLANG}" --version
  OUTPUT_VARIABLE tools_version
  RESULT_VARIABLE tools_result)
if(NOT tools_result EQUAL 0 OR NOT tools_version MATCHES "Hexagon Clang version 19[.]0[.]07([\r\n ]|$)")
  message(FATAL_ERROR "qvac-fabric: hexagon-backend requires Hexagon Tools 19.0.07 at HEXAGON_TOOLS_ROOT")
endif()

list(APPEND PLATFORM_OPTIONS
  -DGGML_HEXAGON=ON
  -DPREBUILT_LIB_DIR=android_aarch64
  "-DHEXAGON_SDK_ROOT=${QVAC_HEXAGON_SDK_ROOT}"
  "-DHEXAGON_TOOLS_ROOT=${QVAC_HEXAGON_TOOLS_ROOT}")
