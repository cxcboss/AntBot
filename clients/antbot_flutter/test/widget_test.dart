import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:antbot_flutter/main.dart';

void main() {
  test('buildAppTheme keeps the requested brightness', () {
    expect(buildAppTheme(Brightness.light).brightness, Brightness.light);
    expect(buildAppTheme(Brightness.dark).brightness, Brightness.dark);
  });
}
